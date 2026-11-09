import { Router } from "express";
import { asyncHandler } from "../../shared/utils/async-handler";
import { ForbiddenError } from "../../shared/utils/errors";
import { authMiddleware } from "../../middleware/auth";
import { auditLogger } from "../../shared/utils/audit";
import { generateRequestId } from "../../shared/utils/errors";

const router = Router();

router.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const requestId = generateRequestId();
    if (!req.user) throw new ForbiddenError("Não autenticado.");

    auditLogger.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: "read_me",
      resource: "session",
      resourceId: req.user.id,
      source: "venda_express",
      outcome: "success",
      timestamp: new Date().toISOString(),
    });
    res.json({
      data: {
        user: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          phone: undefined,
          createdAt: undefined,
        },
        roles: [req.user.role],
        seller: { supplierId: req.user.supplierId, status: "active" },
        stores: req.user.storeId
          ? [
              {
                id: req.user.storeId,
                source: "venda_express",
                name: req.user.name,
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
        accountKind: req.user.accountKind,
        businessType: req.user.businessType,
        storeId: req.user.storeId,
      },
      meta: { requestId },
    });
  }),
);

export default router;
