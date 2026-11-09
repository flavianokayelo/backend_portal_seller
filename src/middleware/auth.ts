import { Request, Response, NextFunction } from "express";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
  structuredLog,
} from "../shared/utils/errors";
import { vendaExpressAdapter } from "../adapters/venda-express/client";
import { verifySessionCookie } from "../shared/utils/session";

const corsOrigin = (
  process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((o) => o.trim());

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  supplierId: string;
  storeId?: string;
  vendaExpressToken?: string;
  accountKind?: "loja" | "fornecedor";
  businessType?: "store" | "restaurant";
}

declare global {
  namespace Express {
    interface Request {
      id?: string;
      user?: AuthUser;
    }
  }
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const sessionCookie = req.cookies?.[process.env.SESSION_COOKIE_NAME || "sid"];
  if (!sessionCookie) {
    next(new UnauthorizedError("Não autenticado."));
    return;
  }

  try {
    const payload = verifySessionCookie(sessionCookie);
    if (!payload) {
      next(new UnauthorizedError("Sessão inválida ou expirada."));
      return;
    }
    const user: AuthUser = {
      id: payload.id,
      name: payload.name || payload.email,
      email: payload.email,
      role: payload.role,
      supplierId: payload.supplierId || "",
      storeId: payload.storeId,
      vendaExpressToken: payload.vendaExpressToken,
      accountKind: payload.accountKind,
      businessType: payload.businessType,
    };
    req.user = user;
    if (user.vendaExpressToken) {
      vendaExpressAdapter.runWithToken(user.vendaExpressToken, () => next());
      return;
    }
    next();
  } catch {
    next(new UnauthorizedError("Sessão inválida."));
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ForbiddenError("Não autenticado."));
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError("Sem permissão para esta ação."));
      return;
    }
    next();
  };
}

export function ownershipMiddleware(
  resourceParam: string,
  resolveOwner: (req: Request) => Promise<string | undefined>,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.user) {
      next(new ForbiddenError("Não autenticado."));
      return;
    }

    const resourceId = req.params[resourceParam];
    if (!resourceId) {
      next(new ForbiddenError("ID do recurso não fornecido."));
      return;
    }

    try {
      const ownerId = await resolveOwner(req);
      if (!ownerId) {
        next(new ForbiddenError("Recurso não encontrado."));
        return;
      }

      if (req.user.role === "admin") {
        next();
        return;
      }

      if (ownerId !== req.user.id && ownerId !== req.user.storeId) {
        structuredLog({
          level: "warn",
          requestId: (req as any).id,
          message: "IDOR attempt blocked",
          context: {
            actorId: req.user.id,
            resourceId,
            resolvedOwner: ownerId,
          },
        });
        next(new ForbiddenError("Não tem permissão sobre este recurso."));
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  structuredLog({
    level: "error",
    requestId: (req as any).id,
    message: err.message,
    context: { stack: err.stack },
  });

  const origin = req.headers.origin;
  const allowed = typeof origin === "string" && corsOrigin.includes(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId: (req as any).id,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Erro interno do servidor.",
      requestId: (req as any).id,
    },
  });
}
