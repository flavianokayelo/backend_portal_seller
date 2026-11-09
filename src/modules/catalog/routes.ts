import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  structuredLog,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { auditLogger } from "../../shared/utils/audit";
import { generateRequestId } from "../../shared/utils/errors";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { isVendaExpressError } from "../../adapters/venda-express/client";
import {
  CreateProductSchema,
  UpdateProductSchema,
} from "../../shared/schemas/validation";
import { legacyProductId, mergeProductPatch, productOrigin, requireProductOrigin, statusFilter, supportsLegacyProductPatch, toLegacyProductPayload } from "./products-domain";

const router = Router();

router.post(
  "/uploads/product-images",
  authMiddleware,
  asyncHandler(async (req, res) => {
    await authorizedProductContext(req);
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data")) {
      throw new ValidationError("O upload exige multipart/form-data.");
    }

    const upstream = await callUpstream(
      () => vendaExpressAdapter.postStream<{ photos?: Array<{ url: string; hash: string }> }>(
        "/uploads/product-images",
        req,
        {
          "content-type": contentType,
          ...(typeof req.headers["content-length"] === "string"
            ? { "content-length": req.headers["content-length"] }
            : {}),
        },
      ),
      "imagens do produto",
    );

    const base = process.env.VENDA_EXPRESS_BASE_URL;
    const photos = (upstream.photos ?? []).map((photo) => ({
      ...photo,
      url: base ? new URL(photo.url, new URL(base).origin).toString() : photo.url,
    }));
    res.status(201).json({ data: { photos }, meta: { requestId: generateRequestId() } });
  }),
);

router.post(
  "/uploads/category-icon",
  authMiddleware,
  asyncHandler(async (req, res) => {
    await authorizedProductContext(req);
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data")) {
      throw new ValidationError("O upload exige multipart/form-data.");
    }

    const upstream = await callUpstream(
      () =>
        vendaExpressAdapter.postStream<{ url?: string; icon_url?: string }>(
          "/uploads/category-icon",
          req,
          {
            "content-type": contentType,
            ...(typeof req.headers["content-length"] === "string"
              ? { "content-length": req.headers["content-length"] }
              : {}),
          },
        ),
      "ícone da categoria",
    );

    const rawUrl = upstream.url ?? upstream.icon_url;
    if (!rawUrl) {
      throw new BadGatewayError("O VendaExpress não devolveu o URL do ícone.");
    }
    const base = process.env.VENDA_EXPRESS_BASE_URL;
    const url = base ? new URL(rawUrl, new URL(base).origin).toString() : rawUrl;
    res.status(201).json({ data: { url }, meta: { requestId: generateRequestId() } });
  }),
);

function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const raw = value.trim();
  if (/^https?:\/\//i.test(raw)) return raw;

  const configured = process.env.VENDA_EXPRESS_BASE_URL;
  if (!configured) return undefined;

  try {
    return new URL(raw, new URL(configured).origin).toString();
  } catch {
    return undefined;
  }
}

function productImageUrls(product: any): string[] {
  const candidates = [
    product.image_url,
    product.imageUrl,
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.photos) ? product.photos : []),
  ];

  return [...new Set(
    candidates
      .map((image: any) =>
        typeof image === "string"
          ? image
          : image?.url ?? image?.image_url ?? image?.src,
      )
      .map(normalizeMediaUrl)
      .filter((url): url is string => Boolean(url)),
  )];
}

function productImageAssets(product: any): Array<{ url: string; hash: string }> {
  const raw = [
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.photos) ? product.photos : []),
  ];
  const assets = raw.flatMap((entry: any) => {
    if (!entry || typeof entry !== "object" || typeof entry.hash !== "string" || !entry.hash) return [];
    const url = normalizeMediaUrl(entry.url ?? entry.image_url ?? entry.src);
    return url ? [{ url, hash: entry.hash }] : [];
  });
  return [...new Map(assets.map((asset) => [asset.hash, asset])).values()];
}

function toProductDto(p: any, categories = new Map<string, string>()) {
  const images = productImageUrls(p);
  const origin = productOrigin(p.source, p.id);
  const categoryId = p.category_id ?? p.categoryId ?? null;
  const sourceId = origin === "sete"
    ? String(p.sete_p_id ?? legacyProductId(String(p.id)) ?? p.id)
    : String(p.id);
  return {
    id: String(p.id),
    source: origin,
    sourceId,
    sku: p.sku || `${origin === "sete" ? "SET" : "VE"}-${sourceId}`,
    name: p.name,
    description: p.description,
    category: p.category ?? p.category_name ?? p.categoryName ?? (categoryId == null ? "Sem categoria" : categories.get(String(categoryId)) ?? categoryId),
    categoryId: categoryId == null ? undefined : String(categoryId),
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? null,
    stock: p.stock,
    lowStockThreshold: p.lowStockThreshold,
    status: p.status ?? (p.active === false || Number(p.active) === 0 ? "archived" : "published"),
    unitsSold: p.unitsSold,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    imageUrl: images[0],
    images,
    imageAssets: productImageAssets(p),
    editableFields: origin === "sete"
      ? ["name", "description", "price", "compareAtPrice", "stock", "status", "productKind", "returnPolicy"]
      : ["name", "description", "category", "price", "compareAtPrice", "stock", "status", "images", "productKind", "itemCondition", "colors", "sizes", "returnPolicy"],
    productKind: p.productKind ?? p.product_kind,
    itemCondition: p.itemCondition ?? p.item_condition,
    colors: p.colors ?? [],
    sizes: p.sizes ?? [],
    returnPolicy: p.returnPolicy ?? p.return_policy ?? "",
  };
}

const categoryMapCache = new Map<string, { categories: Map<string, string>; expiresAt: number }>();

async function categoryNamesById(storeId: string): Promise<Map<string, string>> {
  const cached = categoryMapCache.get(storeId);
  if (cached && Date.now() < cached.expiresAt) return cached.categories;
  const upstream = await callUpstream(() => vendaExpressAdapter.get<any>("/categories"), "categorias");
  const categories = Array.isArray(upstream) ? upstream : upstream?.categories ?? [];
  const categoryMap = new Map<string, string>(categories
    .filter((category: any) => category?.id && (category.name || category.label))
    .map((category: any) => [String(category.id), String(category.name ?? category.label)]));
  categoryMapCache.set(storeId, { categories: categoryMap, expiresAt: Date.now() + 60_000 });
  return categoryMap;
}

function invalidateCategoryCache(storeId?: string): void {
  if (storeId) categoryMapCache.delete(storeId);
  else categoryMapCache.clear();
}

/**
 * Rejeita nomes já existentes na loja VendaExpress **e** no catálogo 7Sete
 * legado (`tbl_product` via fornecedor / id_loja_antiga).
 *
 * O VE com `source=all` devolve VE + legados mapeados; `source=sete` força
 * só a BD 7Sete. Fazemos as duas consultas com `search` para não depender
 * apenas da primeira página sem filtro.
 */
async function assertProductNameAvailable(
  name: string,
  context: ProductContext,
): Promise<void> {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return;

  const collect = (upstream: any): Array<Record<string, any>> => {
    if (Array.isArray(upstream)) return upstream;
    if (Array.isArray(upstream?.products)) return upstream.products;
    if (Array.isArray(upstream?.data)) return upstream.data;
    return [];
  };

  const exactMatch = (rows: Array<Record<string, any>>) =>
    rows.find(
      (row) => String(row?.name ?? "").trim().toLowerCase() === normalized,
    );

  // 1) Catálogo nativo VE + legados agregados (source=all).
  const allUpstream = await callUpstream(
    () =>
      vendaExpressAdapter.get<any>(
        `/products?source=all&limit=500&search=${encodeURIComponent(trimmed)}`,
      ),
    "produtos",
  );
  let clash = exactMatch(collect(allUpstream));

  // 2) Se a loja tem ligação 7Sete, confirma directamente na origem legada.
  //    (Garante cobertura mesmo se o agregado omitir algum registo.)
  if (!clash && context.legacyStoreId !== null) {
    const seteUpstream = await callUpstream(
      () =>
        vendaExpressAdapter.get<any>(
          `/products?source=sete&limit=500&search=${encodeURIComponent(trimmed)}`,
        ),
      "produtos 7Sete",
    );
    clash = exactMatch(collect(seteUpstream));
  }

  if (!clash) return;

  const origin = productOrigin(clash.source, clash.id);
  if (origin === "sete") {
    throw new ConflictError(
      `Já existe um produto com o nome "${trimmed}" no catálogo 7Sete (legado). Escolha outro nome.`,
    );
  }
  throw new ConflictError(
    `Já existe um produto com o nome "${trimmed}" nesta loja (VendaExpress). Escolha outro nome.`,
  );
}

function categoryLabel(product: Record<string, any>, categories: Map<string, string>): string {
  const id = product.category_id ?? product.categoryId;
  return String(product.category ?? product.category_name ?? product.categoryName ?? (id == null ? "Sem categoria" : categories.get(String(id)) ?? id));
}

function upstreamError(error: unknown, resource: string): never {
  if (!isVendaExpressError(error)) {
    structuredLog({ level: "error", message: `Unexpected upstream failure: ${resource}`, context: { error: error instanceof Error ? error.message : String(error) } });
    throw new BadGatewayError("O serviço de produtos está temporariamente indisponível.");
  }
  if (error.upstreamStatus === 401) {
    throw new UnauthorizedError("A sessão com a origem expirou.");
  }
  if (error.upstreamStatus === 403) {
    throw new ForbiddenError("Não tem permissão sobre este recurso.");
  }
  if (error.upstreamStatus === 404) throw new NotFoundError(resource);
  if (error.upstreamStatus === 402) {
    const response =
      typeof error.upstreamResponse === "object" &&
      error.upstreamResponse !== null
        ? (error.upstreamResponse as Record<string, unknown>)
        : {};
    throw new AppError(
      typeof response.error === "string"
        ? response.error
        : "A subscrição do VendaExpress é necessária para consultar este recurso.",
      402,
      typeof response.code === "string" ? response.code : "SUBSCRIPTION_REQUIRED",
    );
  }
  if (error.upstreamStatus && error.upstreamStatus >= 500) {
    throw new BadGatewayError("VendaExpress está temporariamente indisponível.");
  }
  throw new BadGatewayError("Não foi possível consultar o VendaExpress.");
}

function toVendaExpressProductPayload(input: Record<string, any>) {
  const isUuid = typeof input.category === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.category);
  return {
    name: input.name,
    description: input.description || null,
    category_id: isUuid ? input.category : null,
    price: input.price,
    compare_at_price: input.compareAtPrice ?? null,
    stock: input.productKind === "digital" ? 0 : input.stock,
    item_condition: input.itemCondition || "novo",
    product_kind: input.productKind || "fisico",
    colors: input.colors || [],
    sizes: input.sizes || [],
    images: input.imageAssets ?? input.images ?? [],
    video: input.video ?? null,
    active: input.status === "published",
    return_policy: input.returnPolicy || null,
    digital_file_url: input.digital_file_url ?? null,
    digital_file_size: input.digital_file_size ?? null,
    digital_mime: input.digital_mime ?? null,
  };
}

async function resolveCategoryId(value: unknown, storeId = ""): Promise<string | null> {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  const categories = await categoryNamesById(storeId);
  const found = [...categories].find(([, name]) => name.trim().toLowerCase() === value.trim().toLowerCase());
  if (!found?.[0]) throw new ValidationError("A categoria selecionada já não existe no VendaExpress.");
  return found[0];
}

async function callUpstream<T>(operation: () => Promise<T>, resource: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return upstreamError(error, resource);
  }
}

interface ProductContext {
  userId: string;
  storeId: string;
  legacyStoreId: number | null;
}

async function authorizedProductContext(req: Request): Promise<ProductContext> {
  if (!req.user?.vendaExpressToken || !req.user.id) throw new UnauthorizedError("Sessão de vendedor inválida.");
  const me = await callUpstream(
    () => vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me"),
    "sessão",
  );
  const verifiedId = me?.user?.id;
  if (!verifiedId || String(verifiedId) !== String(req.user.id)) throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  if (me.user?.account_kind === "fornecedor") throw new ForbiddenError("A conta de fornecedor não tem produtos de loja própria.");
  const store = await callUpstream(
    () => vendaExpressAdapter.get<{ id?: string; owner_id?: string; id_loja_antiga?: number | string | null }>("/stores/mine"),
    "loja",
  );
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(verifiedId)) throw new ForbiddenError("A loja não pertence ao vendedor autenticado.");
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) throw new ForbiddenError("A loja da sessão não corresponde à loja autorizada.");
  let legacyStoreId: number | null = null;
  if (store.id_loja_antiga !== null && store.id_loja_antiga !== undefined) {
    legacyStoreId = Number(store.id_loja_antiga);
    if (!Number.isSafeInteger(legacyStoreId)) throw new BadGatewayError("O VendaExpress devolveu uma referência legada inválida.");
  }
  return { userId: String(verifiedId), storeId: String(store.id), legacyStoreId };
}

function upstreamSource(source: string | undefined): "all" | "ve" | "sete" {
  if (!source || source === "all") return "all";
  if (source === "ve" || source === "venda_express" || source === "vendaexpress") return "ve";
  if (source === "sete" || source === "7sete") return "sete";
  throw new ValidationError("Origem de produto inválida.");
}

async function listUpstreamProducts(source: "all" | "ve" | "sete", page: number, limit: number, search?: string, filter = "all") {
  const params = new URLSearchParams({ source, page: String(page), limit: String(limit), filter });
  if (search) params.set("search", search);
  return callUpstream(
    () => vendaExpressAdapter.get<{ products?: Array<Record<string, any>>; total?: number; page?: number; limit?: number; meta?: Record<string, unknown> }>(`/products?${params}`),
    "produtos",
  );
}

async function findProductInSource(id: string, source: "ve" | "sete"): Promise<Record<string, any> | undefined> {
  if (source === "sete" && legacyProductId(id) === null) return undefined;
  if (source === "ve" && legacyProductId(id) !== null) return undefined;
  const limit = 500;
  const first = await listUpstreamProducts(source, 1, limit);
  const pages = Math.max(1, Math.ceil(Number(first.total ?? first.products?.length ?? 0) / limit));
  const find = (rows: Array<Record<string, any>> | undefined) => rows?.find((row) => String(row.id) === id);
  const found = find(first.products);
  if (found) return found;
  for (let page = 2; page <= pages; page += 1) {
    const result = await listUpstreamProducts(source, page, limit);
    const product = find(result.products);
    if (product) return product;
    if (!result.products?.length) break;
  }
  return undefined;
}

function sourceForProductRequest(req: Request): "ve" | "sete" {
  const requested = getQueryString(req, "source");
  if (!requested) return legacyProductId(req.params.id) !== null ? "sete" : "ve";
  const source = upstreamSource(requested);
  if (source === "all") throw new ValidationError("Indique a origem do produto para executar esta operação.");
  return source;
}

function editableProduct(row: Record<string, any>) {
  return {
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    category: String(row.category ?? row.category_name ?? row.category_id ?? ""),
    price: Number(row.price ?? 0),
    compareAtPrice: row.compare_at_price == null ? null : Number(row.compare_at_price),
    stock: Number(row.stock ?? 0),
    status: row.active === false || Number(row.active) === 0 ? "archived" : "published",
    productKind: row.product_kind ?? row.productKind ?? "fisico",
    itemCondition: row.item_condition ?? row.itemCondition ?? "novo",
    colors: Array.isArray(row.colors) ? row.colors : [],
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    imageAssets: productImageAssets(row),
    returnPolicy: row.return_policy ?? row.returnPolicy ?? "",
    digital_file_url: row.digital_file_url ?? null,
    digital_file_size: row.digital_file_size ?? null,
    digital_mime: row.digital_mime ?? null,
    video: row.video ?? null,
  };
}

async function persistProductPatch(context: ProductContext, id: string, source: "ve" | "sete", patch: Record<string, unknown>) {
  requireProductOrigin(id, source === "sete" ? "sete" : "venda_express");
  if (source === "sete" && context.legacyStoreId === null) throw new NotFoundError("produto");
  const currentRow = await findProductInSource(id, source);
  if (!currentRow) throw new NotFoundError("produto");
  if (source === "sete" && !supportsLegacyProductPatch(patch)) {
    throw new AppError("Esta operação não está disponível para produtos 7Sete.", 501, "PRODUCT_OPERATION_UNSUPPORTED");
  }
  const current = editableProduct(currentRow);
  const merged = mergeProductPatch(current, patch);
  if (patch.images !== undefined) merged.imageAssets = patch.images as Array<{ url: string; hash: string }>;
  if (merged.status === "draft") throw new ValidationError("A origem não distingue rascunhos de produtos inactivos.");

  if (source === "sete") {
    // O backend tem dispatch explícito para IDs sete-*, que chama updateLegacyProduct
    // e valida o fornecedor associado antes de executar SQL na BD seteEcomerce.
    const updated = await callUpstream(
      () => vendaExpressAdapter.put<Record<string, any>>(`/products/${encodeURIComponent(id)}`, toLegacyProductPayload(merged)),
      "produto 7Sete",
    );
    if (!updated) throw new BadGatewayError("O backend não confirmou a atualização do produto 7Sete.");
    return updated;
  }

  const categoryId = patch.category !== undefined
    ? await resolveCategoryId(merged.category, context.storeId)
    : (currentRow.category_id ?? null);
  const payload = toVendaExpressProductPayload({ ...merged, category: categoryId });
  const updated = await callUpstream(
    () => vendaExpressAdapter.put<Record<string, any>>(`/products/${encodeURIComponent(id)}`, payload),
    "produto",
  );
  if (!updated) throw new NotFoundError("produto");
  return updated;
}

function getQueryString(req: any, key: string): string | undefined {
  const v = req.query[key];
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function getQueryInt(req: any, key: string, def: number): number {
  const v = getQueryString(req, key);
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

router.get(
  "/products",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const page = getQueryInt(req, "page", 1);
    const limit = Math.min(100, Math.max(1, getQueryInt(req, "limit", 100)));
    if (page < 1) throw new ValidationError("A página deve ser um inteiro positivo.");
    const source = upstreamSource(getQueryString(req, "source"));
    const search = getQueryString(req, "search") || "";
    const filter = statusFilter(getQueryString(req, "status"));
    const category = getQueryString(req, "category");
    const categories = await categoryNamesById(context.storeId);

    if (source === "sete" && context.legacyStoreId === null) {
      return res.json({ data: [], meta: { page, limit, total: 0, requestId } });
    }

    let upstream = await listUpstreamProducts(source, page, limit, search, filter);
    let rawProducts = upstream.products ?? [];
    let total = Number(upstream.total ?? rawProducts.length);
    if (category) {
      const first = await listUpstreamProducts(source, 1, 500, search, filter);
      const all = [...(first.products ?? [])];
      const pages = Math.ceil(Number(first.total ?? all.length) / 500);
      for (let nextPage = 2; nextPage <= pages; nextPage += 1) {
        const result = await listUpstreamProducts(source, nextPage, 500, search, filter);
        all.push(...(result.products ?? []));
      }
      const matching = all.filter((product) => categoryLabel(product, categories) === category);
      total = matching.length;
      rawProducts = matching.slice((page - 1) * limit, page * limit);
      upstream = { ...upstream, page, limit };
    }

    const products = rawProducts.map((product) => toProductDto({
      ...product,
      status: product.active === false || Number(product.active) === 0 ? "archived" : "published",
      unitsSold: product.unitsSold ?? product.units_sold ?? 0,
    }, categories));
    res.json({
      data: products,
      meta: { page: upstream.page ?? page, limit: upstream.limit ?? limit, total, requestId },
    });
  }),
);

router.get(
  "/products/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const requestedSource = getQueryString(req, "source");
    const source = requestedSource
      ? upstreamSource(requestedSource)
      : legacyProductId(req.params.id) !== null ? "sete" : "ve";

    let product: Record<string, any> | undefined;
    if (source === "all") {
      const matches = [await findProductInSource(req.params.id, "ve")];
      if (context.legacyStoreId !== null) matches.push(await findProductInSource(req.params.id, "sete"));
      const found = matches.filter(Boolean);
      if (found.length > 1) {
        throw new ValidationError("O ID corresponde a mais de uma origem; indique source=sete ou source=venda_express.");
      }
      product = found[0];
    } else {
      if (source === "sete" && context.legacyStoreId === null) throw new NotFoundError("produto");
      requireProductOrigin(req.params.id, source === "sete" ? "sete" : "venda_express");
      product = await findProductInSource(req.params.id, source);
    }
    if (!product) throw new NotFoundError("produto");

    const origin = productOrigin(product.source, product.id);
    auditLogger.log({
      actorId: context.userId,
      actorRole: req.user?.role ?? "seller",
      action: "read_product",
      resource: "product",
      resourceId: product.id,
      source: origin,
      outcome: "success",
      timestamp: new Date().toISOString(),
    });

    const categories = await categoryNamesById(context.storeId);
    res.json({
      data: toProductDto({
        ...product,
        status: product.active === false || Number(product.active) === 0 ? "archived" : "published",
        unitsSold: product.unitsSold ?? product.units_sold ?? 0,
      }, categories),
      meta: { requestId },
    });
  }),
);

router.post(
  "/products",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const parsed = CreateProductSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados do produto inválidos.", parsed.error.flatten());
    if (parsed.data.status === "draft") throw new ValidationError("O VendaExpress só suporta produtos publicados ou arquivados.");
    if (parsed.data.productKind === "digital") throw new AppError("Criação digital indisponível: é necessário integrar o upload de ficheiros digitais.", 501, "PRODUCT_OPERATION_UNSUPPORTED");
    await assertProductNameAvailable(parsed.data.name, context);
    const categoryId = await resolveCategoryId(parsed.data.category, context.storeId);
    const upstream = await callUpstream(() => vendaExpressAdapter.post<Record<string, any>>("/products", toVendaExpressProductPayload({ ...parsed.data, category: categoryId })), "produto");
    if (!upstream?.id) throw new BadGatewayError("O VendaExpress não confirmou a criação do produto.");
    auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: "create_product", resource: "product", resourceId: upstream.id, source: "venda_express", outcome: "success", timestamp: new Date().toISOString() });
    res.status(201).json({ data: toProductDto({ ...upstream, source: "ve" }), meta: { requestId } });
  }),
);

router.patch(
  "/products/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const source = sourceForProductRequest(req);
    const parsed = UpdateProductSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados do produto inválidos.", parsed.error.flatten());
    if (parsed.data.status === "draft") throw new ValidationError("O VendaExpress só distingue produtos publicados e arquivados.");
    const updated = await persistProductPatch(context, req.params.id, source, parsed.data as Record<string, unknown>);
    const origin = productOrigin(updated.source, updated.id ?? req.params.id);
    auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: "update_product", resource: "product", resourceId: req.params.id, source: origin, outcome: "success", timestamp: new Date().toISOString() });
    res.json({ data: toProductDto({ ...updated, source: updated.source ?? origin }), meta: { requestId } });
  }),
);

router.delete(
  "/products/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const context = await authorizedProductContext(req);
    const source = sourceForProductRequest(req);
    requireProductOrigin(req.params.id, source === "sete" ? "sete" : "venda_express");
    if (source === "sete") throw new AppError("A eliminação de produtos legados está indisponível para proteger relações históricas de pedidos. Arquive o produto para o retirar do catálogo.", 501, "PRODUCT_OPERATION_UNSUPPORTED");
    const product = await findProductInSource(req.params.id, "ve");
    if (!product) throw new NotFoundError("produto");
    await callUpstream(() => vendaExpressAdapter.delete(`/products/${encodeURIComponent(req.params.id)}`), "produto");
    auditLogger.log({ actorId: context.userId, actorRole: req.user?.role ?? "seller", action: "delete_product", resource: "product", resourceId: req.params.id, source: "venda_express", outcome: "success", timestamp: new Date().toISOString() });
    res.status(204).send();
  }),
);

router.patch(
  "/products/:id/stock",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const source = sourceForProductRequest(req);
    const stock = req.body?.stock;
    if (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0) throw new ValidationError("Stock deve ser um número inteiro não negativo.");
    const updated = await persistProductPatch(context, req.params.id, source, { stock });
    res.json({ data: toProductDto({ ...updated, source: updated.source ?? (source === "sete" ? "sete" : "ve") }), meta: { requestId } });
  }),
);
router.get(
  "/categories",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const categories = await categoryNamesById(context.storeId);
    res.json({
      data: [...categories].map(([id, name]) => ({ id, name })),
      meta: { requestId },
    });
  }),
);

/**
 * Cria categoria no VendaExpress.
 * Contrato VE: POST /categories { name, icon_url? }
 */
router.post(
  "/categories",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const context = await authorizedProductContext(req);
    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      throw new ValidationError("O nome da categoria é obrigatório.");
    }

    const iconUrlRaw =
      typeof req.body?.iconUrl === "string"
        ? req.body.iconUrl.trim()
        : typeof req.body?.icon_url === "string"
          ? req.body.icon_url.trim()
          : "";

    // Evita duplicar nome na mesma loja (case-insensitive).
    const existing = await categoryNamesById(context.storeId);
    for (const [, label] of existing) {
      if (label.trim().toLowerCase() === name.toLowerCase()) {
        throw new ConflictError(
          `Já existe uma categoria com o nome "${name}" nesta loja.`,
        );
      }
    }

    const upstream = await callUpstream(
      () =>
        vendaExpressAdapter.post<Record<string, any>>("/categories", {
          name,
          icon_url: iconUrlRaw || null,
        }),
      "categoria",
    );

    if (!upstream?.id) {
      throw new BadGatewayError(
        "O VendaExpress não confirmou a criação da categoria.",
      );
    }

    invalidateCategoryCache(context.storeId);

    const categoryName = String(upstream.name ?? name);
    auditLogger.log({
      actorId: context.userId,
      actorRole: req.user?.role ?? "seller",
      action: "create_category",
      resource: "category",
      resourceId: String(upstream.id),
      source: "venda_express",
      outcome: "success",
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      data: {
        id: String(upstream.id),
        name: categoryName,
        iconUrl:
          normalizeMediaUrl(upstream.icon_url ?? upstream.iconUrl) ?? null,
      },
      meta: { requestId },
    });
  }),
);

export default router;
