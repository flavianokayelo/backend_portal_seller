import { Router } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  ConflictError,
  AppError,
  ForbiddenError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  BadGatewayError,
  structuredLog,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { auditLogger } from "../../shared/utils/audit";
import { generateRequestId, idempotencyStore } from "../../shared/utils/errors";
import {
  CreateStoreSchema,
  UpdateStoreSchema,
} from "../../shared/schemas/validation";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";
import { isVendaExpressError } from "../../adapters/venda-express/client";
import { legacyStoreId, nativeStoreUpdate, storeOrigin, storeOwnedBy, supportsStoreUpdate } from "./stores-domain";

const router = Router();

function toStoreDto(store: any) {
  const legacyId = legacyStoreId(store.id_loja_antiga ?? null);
  const origin = storeOrigin(legacyId);
  return {
    id: store.id,
    sourceId: origin === "legacy" ? String(legacyId) : String(store.id),
    source: origin === "legacy" ? "sete" : "venda_express",
    legacyStoreId: legacyId,
    storeKind: origin,
    editableFields: origin === "native" ? ["name", "description", "whatsapp", "city", "province", "address", "businessType", "avatarUrl", "coverUrl"] : [],
    name: store.name,
    slug: store.slug,
    description: store.description,
    email: store.email,
    phone: store.phone,
    whatsapp: store.whatsapp,
    city: store.city,
    province: store.province,
    address: typeof store.address === "string" ? store.address : "",
    latitude: store.latitude,
    longitude: store.longitude,
    coverUrl: store.coverUrl,
    avatarUrl: store.avatarUrl,
    isPublished: store.isPublished,
    rating: store.rating,
    followers: store.followers,
    openingHours: store.openingHours,
    createdAt: store.createdAt,
    businessType: store.businessType ?? store.business_type ?? "store",
  };
}

async function authorizedStore(req: import("express").Request) {
  if (!req.user?.vendaExpressToken || !req.user.id) {
    throw new UnauthorizedError("Sessão de vendedor inválida.");
  }
  const me = await vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me");
  const verifiedId = me?.user?.id;
  if (!verifiedId || String(verifiedId) !== String(req.user.id)) {
    throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  }
  if (me.user?.account_kind === "fornecedor") throw new ForbiddenError("A conta de fornecedor não tem uma loja própria.");
  const store = await vendaExpressAdapter.get<any>("/stores/mine");
  if (!store?.id) return null;
  if (!storeOwnedBy(store.owner_id, verifiedId, store.id, req.user.storeId)) throw new ForbiddenError("A loja autenticada não pertence a este vendedor.");
  store.id_loja_antiga = legacyStoreId(store.id_loja_antiga ?? null);
  return store;
}

async function uploadStoreAsset(
  req: import("express").Request,
  upstreamPath: "/uploads/store-logo" | "/uploads/store-banner",
) {
  const store = await authorizedStore(req);
  if (!store) throw new NotFoundError("loja");
  if (storeOrigin(store.id_loja_antiga) === "legacy") {
    throw new AppError("Upload indisponível: esta loja antiga requer o serviço de media do 7Sete.", 501, "STORE_OPERATION_UNSUPPORTED");
  }
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data")) {
    throw new ValidationError("O upload exige multipart/form-data.");
  }
  try {
    const response = await vendaExpressAdapter.postStream<Record<string, unknown>>(
      upstreamPath,
      req,
      {
        "content-type": contentType,
        ...(typeof req.headers["content-length"] === "string"
          ? { "content-length": req.headers["content-length"] }
          : {}),
      },
    );
    const base = process.env.VENDA_EXPRESS_BASE_URL || "https://vendaexpress.ao/api";
    const normalize = (value: unknown) => typeof value === "string"
      ? new URL(value, new URL(base).origin).toString()
      : undefined;
    if (upstreamPath.endsWith("store-logo")) {
      return { url: normalize(response.url) };
    }
    return {
      urls: Array.isArray(response.urls)
        ? response.urls.map(normalize).filter((value): value is string => Boolean(value))
        : [],
    };
  } catch {
    throw new BadGatewayError("Erro ao enviar imagem para o VendaExpress.");
  }
}

router.post("/uploads/store-logo", authMiddleware, asyncHandler(async (req, res) => {
  const data = await uploadStoreAsset(req, "/uploads/store-logo");
  if (!data.url) throw new BadGatewayError("O VendaExpress não devolveu o URL do logótipo.");
  res.status(201).json({ data, meta: { requestId: generateRequestId() } });
}));

router.post("/uploads/store-banner", authMiddleware, asyncHandler(async (req, res) => {
  const data = await uploadStoreAsset(req, "/uploads/store-banner");
  if (!Array.isArray(data.urls) || data.urls.length === 0) throw new BadGatewayError("O VendaExpress não devolveu URLs de banner.");
  res.status(201).json({ data, meta: { requestId: generateRequestId() } });
}));

router.get(
  "/store",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    if (!req.user) {
      throw new ForbiddenError("Não autenticado.");
    }

    // Tentar obter a loja do VendaExpress via /api/stores/mine.
    let store: any = null;
    let storeSource: "venda_express" | "sete" = "venda_express";

    try {
      const myStore = await authorizedStore(req);
      if (!myStore) throw new NotFoundError("loja");
      store = {
        id: myStore.id,
        sourceId: myStore.id,
        source: myStore.id_loja_antiga == null ? "venda_express" : "sete",
        id_loja_antiga: myStore.id_loja_antiga,
        name: myStore.name,
        slug: myStore.slug,
        status: myStore.status,
        description: myStore.description ?? "",
        email: myStore.email ?? "",
        phone: myStore.phone ?? "",
        whatsapp: myStore.whatsapp ?? "",
        city: myStore.city ?? myStore.municipality ?? "Benguela",
        province: myStore.province ?? "Benguela",
        address: myStore.address ?? [myStore.street, myStore.reference, myStore.pickup_point].filter(Boolean).join(", "),
        latitude: myStore.latitude,
        longitude: myStore.longitude,
        coverUrl: myStore.coverUrl ?? myStore.banner_url,
        avatarUrl: myStore.avatarUrl ?? myStore.logo_url,
        isPublished:
          myStore.isPublished ??
          myStore.visible_on_app ??
          myStore.status === "active",
        rating: myStore.rating,
        followers: myStore.followers,
        openingHours: myStore.openingHours,
        createdAt: myStore.createdAt ?? myStore.created_at,
        ownerId: myStore.owner_id,
        businessType: myStore.business_type ?? myStore.businessType ?? "store",
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isVendaExpressError(err) && err.upstreamStatus === 404) throw new NotFoundError("loja");
      const errMsg = (err as Error).message;
      if (errMsg.includes("não encontrada")) {
        throw new NotFoundError("loja");
      }
      throw new BadGatewayError("Erro ao consultar loja no VendaExpress.");
    }

    storeSource = storeOrigin(store.id_loja_antiga) === "legacy" ? "sete" : "venda_express";

    if (
      req.user.role !== "admin" &&
      store.ownerId !== req.user.id &&
      store.ownerId !== req.user.storeId
    ) {
      throw new ForbiddenError("Não tem permissão sobre esta loja.");
    }

    auditLogger.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: "read_store",
      resource: "store",
      resourceId: store.id,
      source: storeSource,
      outcome: "success",
      timestamp: new Date().toISOString(),
    });

    res.json({
      data: toStoreDto(store),
      meta: { requestId },
    });
  }),
);

router.post(
  "/store",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    if (!req.user) {
      throw new ForbiddenError("Não autenticado.");
    }

    const idempotencyKeyValue = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyKeyValue === "string" ? idempotencyKeyValue : undefined;
    if (!idempotencyKey) {
      throw new ValidationError("Idempotency-Key é obrigatório.");
    }

    const existing = idempotencyStore.get(idempotencyKey);
    if (existing) {
      res.status(existing.statusCode).json(JSON.parse(existing.body));
      return;
    }

    const parsed = CreateStoreSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        "Dados da loja inválidos.",
        parsed.error.flatten(),
      );
    }

    const { name, email, phone, city, province, businessType } = parsed.data;

    // Gerar slug a partir do nome.
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // O VendaExpress abre novas lojas no plano máximo anual durante o modo
    // aberto. O ID tem de existir na tabela `plans` antes da criação.
    const planId = "plan-diamante-anual";

    try {
      const created = await vendaExpressAdapter.post<{
        id: string;
        name: string;
        slug: string;
        status: string;
        owner_id: string;
        description?: string;
        email?: string;
        phone?: string;
        whatsapp?: string;
        city?: string;
        province?: string;
        address?: string;
        coverUrl?: string;
        avatarUrl?: string;
        isPublished?: boolean;
        rating?: number;
        followers?: number;
        openingHours?: any;
        createdAt?: string;
        business_type?: "store" | "restaurant";
        businessType?: "store" | "restaurant";
      }>("/stores", {
        name,
        slug,
        plan_id: planId,
        business_type: businessType,
      });

      const store = {
        id: created.id,
        sourceId: created.id,
        source: "venda_express",
        name: created.name,
        slug: created.slug,
        description: created.description ?? "",
        email: created.email ?? email,
        phone: created.phone ?? phone,
        whatsapp: created.whatsapp ?? phone,
        city: created.city ?? city,
        province: created.province ?? province,
        address: created.address,
        coverUrl: created.coverUrl,
        avatarUrl: created.avatarUrl,
        isPublished: created.isPublished ?? false,
        rating: created.rating,
        followers: created.followers,
        openingHours: created.openingHours,
        createdAt: created.createdAt,
        ownerId: created.owner_id,
        businessType: created.business_type ?? created.businessType ?? businessType,
      };

      const record = {
        key: idempotencyKey!,
        method: "POST",
        path: "/seller/store",
        statusCode: 201,
        body: JSON.stringify({ data: toStoreDto(store), meta: { requestId } }),
        createdAt: new Date().toISOString(),
      };
      idempotencyStore.set(record);

      auditLogger.log({
        actorId: req.user.id,
        actorRole: req.user.role,
        action: "create_store",
        resource: "store",
        resourceId: store.id,
        source: store.source as "sete" | "venda_express",
        outcome: "success",
        timestamp: new Date().toISOString(),
      });

      res.status(201).json({ data: toStoreDto(store), meta: { requestId } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isVendaExpressError(err) && err.upstreamStatus === 404) throw new NotFoundError("loja");
      const errMsg = (err as Error).message;

      // 409 duplicado (owner já tem loja ou slug ocupado)
      if (errMsg.includes("Já tens uma loja criada")) {
        throw new ConflictError("Esta conta já tem uma loja associada.");
      }
      if (errMsg.includes("já está em uso")) {
        throw new ConflictError("Este endereço de loja já está em uso.");
      }

      // Erros de validação do VE
      if (errMsg.includes("Tens de escolher um plano")) {
        throw new ValidationError("Plano é obrigatório.", {
          code: "PLAN_REQUIRED",
        });
      }
      if (errMsg.includes("Plano inválido")) {
        throw new ValidationError("Plano inválido.", { code: "PLAN_INVALID" });
      }

      throw new BadGatewayError("Erro ao criar loja no VendaExpress.");
    }
  }),
);

router.patch(
  "/store",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    if (!req.user) {
      throw new ForbiddenError("Não autenticado.");
    }

    // Obter a loja atual do VE para verificar ownership.
    let currentStore: any = null;
    try {
      currentStore = await authorizedStore(req);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isVendaExpressError(err) && err.upstreamStatus === 404) throw new NotFoundError("loja");
      const errMsg = (err as Error).message;
      if (errMsg.includes("não encontrada")) {
        throw new NotFoundError("loja");
      }
      throw new BadGatewayError("Erro ao consultar loja no VendaExpress.");
    }

    if (!currentStore) {
      throw new NotFoundError("loja");
    }

    if (
      req.user.role !== "admin" &&
      currentStore.owner_id !== req.user.id &&
      currentStore.owner_id !== req.user.storeId
    ) {
      throw new ForbiddenError("Não tem permissão sobre esta loja.");
    }

    const parsed = UpdateStoreSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        "Dados da loja inválidos.",
        parsed.error.flatten(),
      );
    }

    if (!supportsStoreUpdate(storeOrigin(currentStore.id_loja_antiga), parsed.data as Record<string, unknown>)) {
      throw new AppError("Edição bloqueada: a API de atualização de perfil 7Sete não tem contrato de campos confirmado.", 501, "STORE_OPERATION_UNSUPPORTED");
    }
    if (parsed.data.email !== undefined || parsed.data.phone !== undefined) {
      throw new ValidationError("O contrato VendaExpress não permite atualizar email nem telefone separado; atualize apenas o WhatsApp.");
    }
    if (!supportsStoreUpdate(storeOrigin(currentStore.id_loja_antiga), parsed.data as Record<string, unknown>)) {
      throw new AppError("Edição bloqueada: a API de atualização de perfil 7Sete não tem contrato de campos confirmado.", 501, "STORE_OPERATION_UNSUPPORTED");
    }
    const updatePayload = nativeStoreUpdate(parsed.data as Record<string, unknown>);

    if (Object.keys(updatePayload).length === 0) {
      // Nada a atualizar — devolver a loja atual.
      const store = await vendaExpressAdapter.get<{
        id: string;
        name: string;
        slug: string;
        status: string;
        owner_id: string;
        id_loja_antiga?: number | string | null;
        description?: string;
        email?: string;
        phone?: string;
        whatsapp?: string;
        city?: string;
        province?: string;
        address?: string;
        coverUrl?: string;
        avatarUrl?: string;
        isPublished?: boolean;
        rating?: number;
        followers?: number;
        openingHours?: any;
        createdAt?: string;
        business_type?: "store" | "restaurant";
        businessType?: "store" | "restaurant";
      }>("/stores/mine");

      const updated = {
        id: store.id,
        sourceId: store.id,
        source: storeOrigin(store.id_loja_antiga) === "legacy" ? "sete" : "venda_express",
        id_loja_antiga: store.id_loja_antiga,
        name: store.name,
        slug: store.slug,
        description: store.description ?? "",
        email: store.email ?? "",
        phone: store.phone ?? "",
        whatsapp: store.whatsapp ?? "",
        city: store.city ?? "",
        province: store.province ?? "",
        address: store.address,
        coverUrl: store.coverUrl,
        avatarUrl: store.avatarUrl,
        isPublished: store.isPublished,
        rating: store.rating,
        followers: store.followers,
        openingHours: store.openingHours,
        createdAt: store.createdAt,
        ownerId: store.owner_id,
        businessType: store.business_type ?? store.businessType ?? "store",
      };

      auditLogger.log({
        actorId: req.user.id,
        actorRole: req.user.role,
        action: "update_store",
        resource: "store",
        resourceId: updated.id,
        source: "venda_express",
        outcome: "success",
        timestamp: new Date().toISOString(),
      });

      return res.json({ data: toStoreDto(updated), meta: { requestId } });
    }

    try {
      await vendaExpressAdapter.put("/stores/mine", updatePayload);
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes("já está em uso")) {
        throw new ConflictError("Este endereço de loja já está em uso.");
      }
      throw new BadGatewayError("Erro ao atualizar loja no VendaExpress.");
    }

    // Buscar a loja atualizada.
    const updatedStore = await vendaExpressAdapter.get<{
      id: string;
      name: string;
      slug: string;
      status: string;
      owner_id: string;
      id_loja_antiga?: number | string | null;
      description?: string;
      email?: string;
      phone?: string;
      whatsapp?: string;
      city?: string;
      province?: string;
      address?: string;
      coverUrl?: string;
      avatarUrl?: string;
      isPublished?: boolean;
      rating?: number;
      followers?: number;
      openingHours?: any;
      createdAt?: string;
      business_type?: "store" | "restaurant";
      businessType?: "store" | "restaurant";
    }>("/stores/mine");

    const updated = {
      id: updatedStore.id,
      sourceId: updatedStore.id,
      source: storeOrigin(updatedStore.id_loja_antiga) === "legacy" ? "sete" : "venda_express",
      id_loja_antiga: updatedStore.id_loja_antiga,
      name: updatedStore.name,
      slug: updatedStore.slug,
      description: updatedStore.description ?? "",
      email: updatedStore.email ?? "",
      phone: updatedStore.phone ?? "",
      whatsapp: updatedStore.whatsapp ?? "",
      city: updatedStore.city ?? "",
      province: updatedStore.province ?? "",
      address: updatedStore.address,
      coverUrl: updatedStore.coverUrl,
      avatarUrl: updatedStore.avatarUrl,
      isPublished: updatedStore.isPublished,
      rating: updatedStore.rating,
      followers: updatedStore.followers,
      openingHours: updatedStore.openingHours,
      createdAt: updatedStore.createdAt,
      ownerId: updatedStore.owner_id,
      businessType: updatedStore.business_type ?? updatedStore.businessType ?? "store",
    };

    auditLogger.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: "update_store",
      resource: "store",
      resourceId: updated.id,
      source: "venda_express",
      outcome: "success",
      timestamp: new Date().toISOString(),
    });

    res.json({ data: toStoreDto(updated), meta: { requestId } });
  }),
);

export default router;
