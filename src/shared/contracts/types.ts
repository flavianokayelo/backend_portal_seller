export type PlatformSource = "sete" | "venda_express";
export type DataSource = "mock" | "api";

export interface Seller {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  storeId: string;
  memberSince?: string;
}

export interface SellerSession {
  seller: Seller;
  storeId: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface Store {
  id: string;
  sourceId?: string;
  name: string;
  slug: string;
  description: string;
  email: string;
  phone: string;
  whatsapp: string;
  city: string;
  province: string;
  address?: string;
  coverUrl: string;
  avatarUrl: string;
  isPublished: boolean;
  rating?: number;
  followers?: number;
  openingHours: OpeningHours[];
  createdAt?: string;
  source: PlatformSource;
}

export interface OpeningHours {
  day: number;
  label: string;
  opensAt: string | null;
  closesAt: string | null;
}

export interface CreateStoreInput {
  name: string;
  description?: string;
  email: string;
  phone: string;
  city: string;
  province: string;
  address?: string;
}

export interface UpdateStoreInput {
  name?: string;
  description?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  city?: string;
  province?: string;
  address?: string;
}

export type ProductStatus = "published" | "draft" | "archived";

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  lowStockThreshold: number;
  status: ProductStatus;
  source: PlatformSource;
  unitsSold: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductQuery {
  search?: string;
  category?: string;
  status?: ProductStatus | "all";
  source?: PlatformSource | "all";
  kind?: string;
  page?: number;
  limit?: number;
}

export interface CreateProductInput {
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
  status: ProductStatus;
  source?: PlatformSource;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  category?: string;
  price?: number;
  stock?: number;
  status?: ProductStatus;
}

export interface OrderStatusCounts {
  total: number;
  byStatus: Record<string, number>;
}

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "preparing"
  | "ready"
  | "shipped"
  | "delivered"
  | "cancelled";

export type PaymentMethod =
  "multicaixa" | "transferencia" | "dinheiro" | "cartao" | "outro";

export type DeliveryMethod = "entrega" | "recolha" | "outro";

export interface OrderItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderStatusEvent {
  status: OrderStatus;
  at: string;
}

export interface Order {
  id: string;
  reference: string;
  source: PlatformSource;
  customerId: string;
  customerName: string;
  customerPhone: string;
  createdAt: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  deliveryMethod: DeliveryMethod;
  deliveryCity: string;
  deliveryAddress: string;
  note: string | null;
  statusHistory: OrderStatusEvent[];
}

export interface OrderQuery {
  search?: string;
  status?: OrderStatus | "all";
  source?: PlatformSource;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  segment: "novo" | "recorrente" | "vip";
  ordersCount: number;
  totalSpent: number;
  lastActivityAt: string;
  customerSince: string;
}

export interface CustomerQuery {
  search?: string;
  page?: number;
  limit?: number;
}

export type NotificationKind = "order" | "stock" | "payout" | "system";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  description: string;
  createdAt: string;
  isRead: boolean;
  href?: string;
}

export type DateRange = "7d" | "30d" | "90d";

export interface AnalyticsOverview {
  range: DateRange;
  summary: {
    revenue: number;
    orders: number;
    averageOrderValue: number;
    revenueChange: number | null;
    ordersChange: number | null;
    averageOrderValueChange: number | null;
    conversionRate: number | null;
    conversionRateChange: number | null;
    storeVisits: number | null;
    storeVisitsChange: number | null;
  };
  series: Array<{ date: string; revenue: number; orders: number }>;
  topProducts: Array<{
    productId: string;
    source?: PlatformSource;
    name: string;
    unitsSold: number;
    revenue: number;
  }>;
  categoryBreakdown: Array<{ label: string; value: number }>;
  orderStatusBreakdown: Array<{ status: string; count: number }>;
  generatedAt: string;
}

export interface PayoutMethod {
  id: string;
  storeId: string;
  type: "iban";
  ibanMasked: string;
  bankName?: string;
  accountHolder?: string;
  isActive: boolean;
  createdAt: string;
}
