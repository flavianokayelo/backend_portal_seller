import { z } from "zod";

export const SignInSchema = z.object({
  email: z.string().email("Email inválido."),
  password: z.string().min(1, "Palavra-passe é obrigatória."),
});

// ADICIONADO: criação de conta
export const SignUpSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Nome é obrigatório.")
    .max(120, "Nome demasiado longo."),
  email: z.string().trim().email("Email inválido."),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{9,18}$/, "Telefone inválido.")
    .optional()
    .or(z.literal("")),
  password: z
    .string()
    .min(8, "A palavra-passe deve ter pelo menos 8 caracteres.")
    .max(128, "Palavra-passe demasiado longa."),
});

export const CreateStoreSchema = z.object({
  name: z.string().min(2, "Nome da loja é obrigatório."),
  description: z.string().optional(),
  email: z.string().email("Email inválido."),
  phone: z.string().min(9, "Telefone inválido."),
  city: z.string().min(2, "Cidade é obrigatória."),
  province: z.string().min(2, "Província é obrigatória."),
  address: z.string().optional(),
  businessType: z.enum(["store", "restaurant"]).default("store"),
});

export const UpdateStoreSchema = CreateStoreSchema.partial().extend({
  avatarUrl: z.string().url("URL do logótipo inválida.").optional(),
  coverUrl: z.string().url("URL do banner inválida.").optional(),
});

export const CreateProductSchema = z.object({
  name: z.string().min(3, "Nome do produto deve ter pelo menos 3 caracteres."),
  description: z.string().optional(),
  category: z.string().min(1, "Categoria é obrigatória."),
  price: z.number().positive("Preço deve ser superior a zero."),
  stock: z.number().int().nonnegative("Stock deve ser inteiro não negativo."),
  status: z.enum(["published", "draft", "archived"]),
  productKind: z.enum(["fisico", "comida", "agropecuario", "digital", "outro"]).default("fisico"),
  itemCondition: z.enum(["novo", "usado", "recondicionado"]).default("novo"),
  compareAtPrice: z.number().positive().nullable().optional(),
  colors: z.array(z.object({ name: z.string().min(1), hex: z.string().optional() })).max(20).optional(),
  sizes: z.array(z.string().min(1)).max(20).optional(),
  images: z.array(z.object({ url: z.string().url(), hash: z.string().min(1) })).max(5).optional(),
  returnPolicy: z.string().max(5000).optional(),
});

export const UpdateProductSchema = CreateProductSchema.partial();

export const OrderStatusSchema = z.enum([
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "shipped",
  "delivered",
  "cancelled",
]);

export const PaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .partial();
