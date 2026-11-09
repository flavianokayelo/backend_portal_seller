import { Router } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../shared/utils/errors";
import { auditLogger } from "../../shared/utils/audit";
import { generateRequestId } from "../../shared/utils/errors";
import { SignInSchema } from "../../shared/schemas/validation";
import { loginRateLimiter } from "../../middleware/rate-limit";
import { SESSION_TTL_SECONDS, signSessionCookie } from "../../shared/utils/session";
import {
  isVendaExpressError,
  vendaExpressAdapter,
} from "../../adapters/venda-express/client";

const router = Router();

router.post(
  "/login",
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    const parsed = SignInSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(
        "Credenciais inválidas.",
        parsed.error.flatten(),
      );

    const { email, password } = parsed.data;
    try {
      const veLogin = await vendaExpressAdapter.post<{
        user: { id: string; email: string };
        token: string;
        account?: { kind?: string; capabilities?: { store?: boolean } };
      }>("/auth/login", { email, password });

      if (!veLogin.token || !veLogin.user?.id) {
        throw new UnauthorizedError("Email ou palavra-passe incorretos.");
      }

      vendaExpressAdapter.setToken(veLogin.token);
      const me = await vendaExpressAdapter.get<{
        user: {
          id: string;
          email: string;
          name?: string;
          account_kind?: string;
        };
        account?: { kind?: string; capabilities?: { store?: boolean } };
      }>("/auth/me");

      const accountKind = me.user.account_kind || me.account?.kind || "loja";
      const normalizedAccountKind: "loja" | "fornecedor" =
        accountKind === "fornecedor" ? "fornecedor" : "loja";
      const role = accountKind === "fornecedor" ? "supplier" : "seller";
      let storeId: string | undefined;
      let businessType: "store" | "restaurant" | undefined;
      if (me.account?.capabilities?.store) {
        try {
          const store = await vendaExpressAdapter.get<{
            id: string;
            business_type?: string;
            businessType?: string;
          }>(
            "/stores/mine",
          );
          storeId = store.id;
          const rawBusinessType = store.business_type ?? store.businessType;
          if (rawBusinessType === "store" || rawBusinessType === "restaurant") {
            businessType = rawBusinessType;
          }
        } catch (error) {
          if (isVendaExpressError(error) && error.upstreamStatus !== 404)
            throw error;
        }
      }

      const user = {
        id: veLogin.user.id,
        name: me.user.name || veLogin.user.email,
        email: me.user.email || veLogin.user.email,
        role,
        supplierId: accountKind === "fornecedor" ? veLogin.user.id : "",
        storeId,
        vendaExpressToken: veLogin.token,
        accountKind: normalizedAccountKind,
        businessType,
      };

      const cookieName = process.env.SESSION_COOKIE_NAME || "sid";
      res.cookie(cookieName, signSessionCookie(user), {
        httpOnly: true,
        secure:
          process.env.NODE_ENV === "production" ||
          process.env.SESSION_COOKIE_SECURE === "true",
        sameSite: (process.env.SESSION_COOKIE_SAMESITE || "lax") as
          "lax" | "strict" | "none",
        domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
        path: "/",
        maxAge: SESSION_TTL_SECONDS * 1000,
      });

      auditLogger.log({
        actorId: user.id,
        actorRole: user.role,
        action: "login",
        resource: "session",
        resourceId: user.id,
        source: "venda_express",
        outcome: "success",
        timestamp: new Date().toISOString(),
      });
      res.json({
        data: {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: undefined,
            createdAt: undefined,
          },
          roles: [user.role],
          seller: { supplierId: user.supplierId, status: "active" },
          stores: user.storeId
            ? [
                {
                  id: user.storeId,
                  source: "venda_express",
                  name: user.name,
                  status: "active",
                },
              ]
            : [],
          permissions: [
            "store:read",
            "store:write",
            "product:read",
            "product:write",
            "order:read",
            "order:write",
          ],
          accountKind: user.accountKind,
          businessType: user.businessType,
        },
        meta: { requestId },
      });
    } catch (error) {
      if (!isVendaExpressError(error)) throw error;
      if (error.upstreamStatus === 401)
        throw new UnauthorizedError("Email ou palavra-passe incorretos.");
      if (error.upstreamStatus === 403)
        throw new ForbiddenError("A conta não está autorizada.");
      if (error.upstreamStatus === 500)
        throw new AppError(
          "Erro interno do VendaExpress.",
          500,
          "UPSTREAM_INTERNAL_ERROR",
        );
      throw new AppError(
        "O VendaExpress está temporariamente indisponível.",
        502,
        "VENDA_EXPRESS_UNAVAILABLE",
      );
    }
  }),
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    vendaExpressAdapter.clearToken();
    res.clearCookie(process.env.SESSION_COOKIE_NAME || "sid", {
      httpOnly: true,
      sameSite: (process.env.SESSION_COOKIE_SAMESITE || "lax") as
        "lax" | "strict" | "none",
      domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
      path: "/",
    });
    auditLogger.log({
      actorId: req.user?.id ?? "unknown",
      actorRole: req.user?.role ?? "unknown",
      action: "logout",
      resource: "session",
      resourceId: req.user?.id ?? "unknown",
      source: "integration",
      outcome: "success",
      timestamp: new Date().toISOString(),
    });
    res.json({ data: { ok: true }, meta: { requestId } });
  }),
);

export default router;
