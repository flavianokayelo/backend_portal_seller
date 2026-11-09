import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  generateRequestId,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { setePhpAdapter } from "../../adapters/sete-php/client";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";

const router = Router();
const LEGACY_REVIEWS_ENDPOINT = "/api_avaliacoes.php";

interface ReviewContext {
  storeId: string;
  legacyStoreId: number | null;
  userId: string;
}

interface LegacyReview {
  id: number | string;
  cliente_id?: number | string | null;
  nome_cliente?: string | null;
  nota?: number | string | null;
  comentario?: string | null;
  tempo?: string | null;
  data_avaliacao?: string | null;
  target?: string | null;
  tipo?: string | null;
  product_name?: string | null;
  produto_id?: number | string | null;
  ve_product_id?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

function queryValue(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, max?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new ValidationError("Parâmetro de paginação inválido.");
  }
  return parsed;
}

/** Revalida sessão, identidade, ownership e a associação legada no backend VE. */
async function authorizedContext(req: Request): Promise<ReviewContext> {
  if (!req.user?.vendaExpressToken || !req.user.id) {
    throw new UnauthorizedError("Sessão de vendedor inválida.");
  }
  const me = await vendaExpressAdapter.get<{ user?: { id?: string; account_kind?: string } }>("/auth/me");
  if (!me?.user?.id || String(me.user.id) !== String(req.user.id)) {
    throw new UnauthorizedError("A sessão já não corresponde à conta autenticada.");
  }
  if (me.user.account_kind === "fornecedor") {
    throw new ForbiddenError("A conta de fornecedor não tem avaliações de uma loja própria.");
  }
  const store = await vendaExpressAdapter.get<{
    id?: string | number;
    owner_id?: string | number;
    id_loja_antiga?: number | string | null;
  } | null>("/stores/mine");
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(me.user.id)) {
    throw new ForbiddenError("A loja autenticada não pertence a este vendedor.");
  }
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) {
    throw new ForbiddenError("A loja da sessão não corresponde à loja autorizada.");
  }
  let legacyStoreId: number | null = null;
  if (store.id_loja_antiga !== null && store.id_loja_antiga !== undefined) {
    legacyStoreId = Number(store.id_loja_antiga);
    if (!Number.isSafeInteger(legacyStoreId) || legacyStoreId < 0) {
      throw new BadGatewayError("O VendaExpress devolveu uma associação legada inválida.");
    }
  }
  return { userId: String(me.user.id), storeId: String(store.id), legacyStoreId };
}

function unsupported(message: string): AppError {
  return new AppError(message, 501, "REVIEW_OPERATION_UNSUPPORTED");
}

function reviewDto(review: LegacyReview) {
  if (review.id === undefined || review.id === null) {
    throw new BadGatewayError("A API 7Sete devolveu uma avaliação sem identificador.");
  }
  const rating = review.nota == null || review.nota === "" ? null : Number(review.nota);
  return {
    id: `sete:${String(review.id)}`,
    source: "sete" as const,
    sourceId: String(review.id),
    customerName: review.nome_cliente ?? null,
    customerId: review.cliente_id == null ? null : String(review.cliente_id),
    rating: rating !== null && Number.isFinite(rating) ? rating : null,
    comment: review.comentario ?? null,
    productName: review.product_name ?? null,
    productId: review.produto_id == null ? review.ve_product_id ?? null : String(review.produto_id),
    target: review.target ?? review.tipo ?? null,
    createdAt: review.data_avaliacao ?? review.tempo ?? null,
    timeLabel: review.tempo ?? null,
    status: null,
    sellerResponse: null,
    avatarUrl: review.avatar_url ?? null,
  };
}

interface LegacyEnvelope {
  success?: boolean;
  data?: LegacyReview[];
  meta?: { total?: number; media?: number | null; distribuicao?: Record<string, number> };
  error?: string;
}

async function legacyPage(context: ReviewContext, limit: number, offset: number): Promise<LegacyEnvelope> {
  if (context.legacyStoreId === null) {
    throw unsupported("O backend VendaExpress ainda não disponibiliza avaliações da loja.");
  }
  const params = new URLSearchParams({
    fornecedor_id: String(context.legacyStoreId),
    limit: String(limit),
    offset: String(offset),
  });
  let result: LegacyEnvelope;
  try {
    result = await setePhpAdapter.get<LegacyEnvelope>(`${LEGACY_REVIEWS_ENDPOINT}?${params}`);
  } catch {
    throw new BadGatewayError("O sistema 7Sete está temporariamente indisponível para consultar avaliações.");
  }
  if (!result || result.success !== true || !Array.isArray(result.data)) {
    throw new BadGatewayError("A API 7Sete devolveu uma resposta de avaliações inválida.");
  }
  return result;
}

router.get("/reviews", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const page = positiveInteger(queryValue(req, "page"), 1);
  const limit = positiveInteger(queryValue(req, "limit"), 20, 100);
  const offset = (page - 1) * limit;
  const result = await legacyPage(context, limit, offset);
  const total = result.meta?.total;
  const legacyComplete = typeof total === "number" && Number.isFinite(total) && offset + result.data!.length >= total;
  res.json({
    data: result.data!.map(reviewDto),
    meta: {
      page,
      limit,
      total: typeof total === "number" && Number.isFinite(total) ? total : null,
      source: "sete",
      sourceStatus: { venda_express: "unsupported", sete: "available" },
      dataComplete: false,
      legacyDataComplete: legacyComplete,
      averageRating: null,
      ratingDistribution: null,
      repliesSupported: false,
      requestId: generateRequestId(),
    },
  });
}));

router.get("/reviews/:id", authMiddleware, asyncHandler(async (req, res) => {
  const context = await authorizedContext(req);
  const requestedId = req.params.id;
  const separator = requestedId.indexOf(":");
  if (separator < 0 || requestedId.slice(0, separator) !== "sete") {
    throw new ValidationError("O identificador da avaliação deve incluir uma origem válida.");
  }
  const sourceId = requestedId.slice(separator + 1);
  if (!sourceId) throw new ValidationError("Identificador da avaliação inválido.");
  const first = await legacyPage(context, 100, 0);
  const total = typeof first.meta?.total === "number" ? first.meta.total : first.data!.length;
  let match = first.data!.find((item) => String(item.id) === sourceId);
  for (let offset = 100; !match && offset < total; offset += 100) {
    const next = await legacyPage(context, 100, offset);
    match = next.data?.find((item) => String(item.id) === sourceId);
    if (!next.data?.length) break;
  }
  if (!match) throw new NotFoundError("avaliação");
  res.json({ data: reviewDto(match), meta: { source: "sete", requestId: generateRequestId() } });
}));

router.post("/reviews/:id/response", authMiddleware, asyncHandler(async (req, res) => {
  await authorizedContext(req);
  throw unsupported("O 7Sete não disponibiliza um contrato para o vendedor responder a avaliações.");
}));

export default router;
