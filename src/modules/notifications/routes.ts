import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  BadGatewayError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  generateRequestId,
} from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { vendaExpressAdapter } from "../../adapters/venda-express/client";

const router = Router();

interface NotificationContext {
  userId: string;
  storeId: string;
  legacyStoreId: number | null;
}

async function authorizedContext(req: Request): Promise<NotificationContext> {
  if (!req.user?.vendaExpressToken || !req.user.id) {
    throw new UnauthorizedError("Sessão de vendedor inválida.");
  }

  let me: { user?: { id?: string; account_kind?: string } };
  let store: {
    id?: string | number;
    owner_id?: string | number;
    id_loja_antiga?: string | number | null;
  } | null;
  try {
    me = await vendaExpressAdapter.get("/auth/me");
    store = await vendaExpressAdapter.get("/stores/mine");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new BadGatewayError(
      "Não foi possível validar a conta e a loja no VendaExpress.",
    );
  }

  if (!me?.user?.id || String(me.user.id) !== String(req.user.id)) {
    throw new UnauthorizedError(
      "A sessão já não corresponde à conta autenticada.",
    );
  }
  if (me.user.account_kind === "fornecedor") {
    throw new ForbiddenError(
      "A conta de fornecedor não tem notificações de uma loja própria.",
    );
  }
  if (!store?.id) throw new NotFoundError("loja");
  if (!store.owner_id || String(store.owner_id) !== String(me.user.id)) {
    throw new ForbiddenError(
      "A loja autenticada não pertence a este vendedor.",
    );
  }
  if (req.user.storeId && String(req.user.storeId) !== String(store.id)) {
    throw new ForbiddenError(
      "A loja da sessão já não corresponde à loja autorizada.",
    );
  }

  let legacyStoreId: number | null = null;
  if (store.id_loja_antiga !== null && store.id_loja_antiga !== undefined) {
    legacyStoreId = Number(store.id_loja_antiga);
    if (!Number.isSafeInteger(legacyStoreId) || legacyStoreId < 0) {
      throw new BadGatewayError(
        "O VendaExpress devolveu uma associação legada inválida.",
      );
    }
  }
  return {
    userId: String(me.user.id),
    storeId: String(store.id),
    legacyStoreId,
  };
}

/**
 * Motivo pelo qual o feed ainda não é completo.
 * O frontend trata `complete: false` como “origem indisponível” e não mostra
 * contador de não lidas.
 */
function unavailableMeta(context: NotificationContext): {
  code: string;
  message: string;
} {
  if (context.legacyStoreId !== null) {
    return {
      code: "NOTIFICATIONS_IDENTITY_MAPPING_REQUIRED",
      message:
        "Notificações 7Sete indisponíveis: falta o mapeamento confirmado entre a conta VendaExpress e o userid legado. O ID do fornecedor não é usado como userid.",
    };
  }
  return {
    code: "NOTIFICATIONS_SOURCE_UNSUPPORTED",
    message:
      "O backend VendaExpress ainda não disponibiliza um contrato de notificações para lojas.",
  };
}

/**
 * GET /seller/notifications
 *
 * Enquanto não existir contrato confirmado na origem, devolve 200 com lista
 * vazia e `meta.complete: false` (opção A). Assim o browser não regista 501
 * no console e o portal trata o feed como incompleto, sem inventar dados.
 */
router.get(
  "/notifications",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const context = await authorizedContext(req);
    const reason = unavailableMeta(context);
    const requestId = generateRequestId();

    res.status(200).json({
      data: [],
      meta: {
        complete: false,
        unreadCount: null,
        code: reason.code,
        message: reason.message,
        requestId,
      },
    });
  }),
);

/**
 * PATCH /seller/notifications/:id/read
 *
 * Continua a recusar alterações de estado de leitura enquanto não houver
 * operação persistente na origem — evita marcar como lida uma notificação
 * que a API ainda não consegue ler nem gravar.
 */
router.patch(
  "/notifications/:id/read",
  authMiddleware,
  asyncHandler(async (req: Request) => {
    const context = await authorizedContext(req);
    const reason = unavailableMeta(context);
    throw new AppError(reason.message, 501, reason.code);
  }),
);

export default router;
