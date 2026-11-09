import type {
  CreateProductInput,
  Customer,
  Order,
  Product,
  Store,
  UpdateProductInput,
} from "../../shared/contracts/types";

interface SeedUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  supplierId: string;
  storeId?: string;
  createdAt: string;
}

interface SeedStore {
  id: string;
  sourceId: string;
  source: "sete" | "venda_express";
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
  openingHours: Array<{
    day: number;
    label: string;
    opensAt: string | null;
    closesAt: string | null;
  }>;
  createdAt: string;
  ownerId: string;
}

interface SeedProduct {
  id: string;
  sku: string;
  source: "sete" | "venda_express";
  ownerId: string;
  name: string;
  description: string;
  category: string;
  price: number;
  compareAtPrice?: number | null;
  stock: number;
  lowStockThreshold: number;
  status: "published" | "draft" | "archived";
  unitsSold: number;
  createdAt: string;
  updatedAt: string;
}

interface SeedOrder {
  id: string;
  reference: string;
  source: "sete" | "venda_express";
  customerId: string;
  customerName: string;
  customerPhone: string;
  createdAt: string;
  status: Order["status"];
  items: Order["items"];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  paymentMethod: Order["paymentMethod"];
  deliveryMethod: Order["deliveryMethod"];
  deliveryCity: string;
  deliveryAddress: string;
  note: string | null;
  statusHistory: Order["statusHistory"];
  ownerId: string;
}

interface SeedReview {
  id: string;
  productId: string;
  storeId: string;
  customerId: string;
  customerName: string;
  rating: number;
  comment: string;
  createdAt: string;
  isPublished: boolean;
  ownerId: string;
}

interface SeedPayoutMethod {
  id: string;
  storeId: string;
  type: "iban";
  iban: string;
  ibanMasked: string;
  bankName?: string;
  accountHolder?: string;
  isActive: boolean;
  createdAt: string;
}

const NOW = new Date().toISOString();

const users: SeedUser[] = [
  {
    id: "sel_nzinga",
    name: "Nzinga Baptista",
    email: "nzinga@muximaconcept.ao",
    passwordHash:
      "$2a$10$K7x3L9m2P8q1R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1c2v3b4n5", // bcrypt of "password123"
    role: "seller",
    supplierId: "sup_muxima",
    storeId: "str_muxima",
    createdAt: NOW,
  },
];

const stores: SeedStore[] = [
  {
    id: "str_muxima",
    sourceId: "ve_str_001",
    source: "venda_express",
    name: "Muxima Concept Store",
    slug: "muxima-concept-store",
    description:
      "Curadoria de peças de autor, têxteis e objectos para a casa, produzidos em Angola e em Portugal.",
    email: "loja@muximaconcept.ao",
    phone: "+244 923 000 114",
    whatsapp: "+244 923 000 114",
    city: "Benguela",
    province: "Benguela",
    address: "Miramar, Via S8, Belas Business Park, Loja 12",
    coverUrl: "/images/store-cover.svg",
    avatarUrl: "/images/store-avatar.svg",
    isPublished: true,
    rating: 4.8,
    followers: 1284,
    openingHours: [
      { day: 1, label: "Segunda-feira", opensAt: "09:00", closesAt: "18:00" },
      { day: 2, label: "Terça-feira", opensAt: "09:00", closesAt: "18:00" },
      { day: 3, label: "Quarta-feira", opensAt: "09:00", closesAt: "18:00" },
      { day: 4, label: "Quinta-feira", opensAt: "09:00", closesAt: "18:00" },
      { day: 5, label: "Sexta-feira", opensAt: "09:00", closesAt: "18:00" },
      { day: 6, label: "Sábado", opensAt: "09:00", closesAt: "14:00" },
      { day: 0, label: "Domingo", opensAt: null, closesAt: null },
    ],
    createdAt: NOW,
    ownerId: "sel_nzinga",
  },
];

const products: SeedProduct[] = [
  {
    id: "prd_samakaka",
    sku: "MOD-SAM-001",
    source: "sete",
    ownerId: "sel_nzinga",
    name: "Conjunto Samakaka em algodão",
    description:
      "Conjunto de duas peças em algodão estampado Samakaka, corte relaxado e costura local.",
    category: "Moda",
    price: 38500,
    compareAtPrice: 45000,
    stock: 12,
    lowStockThreshold: 4,
    status: "published",
    unitsSold: 42,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "prd_panela",
    sku: "CAS-PAN-014",
    source: "sete",
    ownerId: "sel_nzinga",
    name: "Panela de barro artesanal 5 L",
    description: "Panela em barro cozido, ideal para cozinhados tradicionais.",
    category: "Casa",
    price: 22900,
    compareAtPrice: null,
    stock: 3,
    lowStockThreshold: 4,
    status: "published",
    unitsSold: 31,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const orders: SeedOrder[] = [
  {
    id: "ord_10321",
    reference: "7S-10321",
    source: "sete",
    customerId: "cus_ana",
    customerName: "Ana Domingos",
    customerPhone: "+244 923 114 780",
    createdAt: NOW,
    status: "pending",
    items: [
      { productId: "prd_colar", name: "Colar de missangas", sku: "ACE-COL-029", quantity: 1, unitPrice: 12750 },
      { productId: "prd_sabonete", name: "Sabonete artesanal de muxixe", sku: "BEL-SAB-045", quantity: 3, unitPrice: 4800 },
    ],
    subtotal: 27150,
    shipping: 1500,
    discount: 0,
    total: 28650,
    paymentMethod: "multicaixa",
    deliveryMethod: "entrega",
    deliveryCity: "Benguela",
    deliveryAddress: "Rua 21 de Janeiro, 45, Miramar",
    note: "Entregar após as 17h, se possível.",
    statusHistory: [{ status: "pending", at: NOW }],
    ownerId: "sel_nzinga",
  },
];

const customers: Customer[] = [
  {
    id: "cus_ana",
    name: "Ana Domingos",
    email: "ana.domingos@example.ao",
    phone: "+244 923 114 780",
    city: "Benguela",
    segment: "vip",
    ordersCount: 8,
    totalSpent: 412500,
    lastActivityAt: NOW,
    customerSince: NOW,
  },
];

const reviews: SeedReview[] = [];

const payoutMethods: SeedPayoutMethod[] = [];

export class DataStore {
  getUserByEmail(email: string): SeedUser | undefined {
    return users.find((u) => u.email === email);
  }

  getUserById(id: string): SeedUser | undefined {
    return users.find((u) => u.id === id);
  }

  getStoreById(id: string): SeedStore | undefined {
    return stores.find((s) => s.id === id);
  }

  getStoreByOwnerId(ownerId: string): SeedStore | undefined {
    return stores.find((s) => s.ownerId === ownerId);
  }

  getStoreBySlug(slug: string): SeedStore | undefined {
    return stores.find((s) => s.slug === slug);
  }

  createStore(store: Omit<SeedStore, "id" | "createdAt">): SeedStore {
    const id = `str_${Date.now().toString(36)}`;
    const created: SeedStore = { ...store, id, createdAt: NOW };
    stores.push(created);
    return created;
  }

  updateStore(id: string, data: Partial<SeedStore>): SeedStore | undefined {
    const index = stores.findIndex((s) => s.id === id);
    if (index === -1) return undefined;
    stores[index] = { ...stores[index], ...data };
    return stores[index];
  }

  getProducts(): SeedProduct[] {
    return products;
  }

  getProductById(id: string, source?: string): SeedProduct | undefined {
    return products.find((p) => p.id === id && (!source || p.source === source));
  }

  createProduct(data: Omit<SeedProduct, "id" | "createdAt" | "updatedAt">): SeedProduct {
    const id = `prd_${Date.now().toString(36)}`;
    const created: SeedProduct = {
      ...data,
      id,
      createdAt: NOW,
      updatedAt: NOW,
    };
    products.push(created);
    return created;
  }

  updateProduct(id: string, data: Partial<SeedProduct>): SeedProduct | undefined {
    const index = products.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    products[index] = { ...products[index], ...data, updatedAt: NOW };
    return products[index];
  }

  deleteProduct(id: string): boolean {
    const index = products.findIndex((p) => p.id === id);
    if (index === -1) return false;
    products.splice(index, 1);
    return true;
  }

  getOrders(): SeedOrder[] {
    return orders;
  }

  getOrderById(id: string, source?: string): SeedOrder | undefined {
    return orders.find((o) => o.id === id && (!source || o.source === source));
  }

  updateOrderStatus(id: string, status: Order["status"]): SeedOrder | undefined {
    const order = this.getOrderById(id);
    if (!order) return undefined;
    order.status = status;
    order.statusHistory.push({ status, at: NOW });
    return order;
  }

  getCustomers(): Customer[] {
    return customers;
  }

  getReviews(): SeedReview[] {
    return reviews;
  }

  getPayoutMethods(storeId: string): SeedPayoutMethod[] {
    return payoutMethods.filter((m) => m.storeId === storeId);
  }

  createPayoutMethod(
    data: Omit<SeedPayoutMethod, "id" | "createdAt">,
  ): SeedPayoutMethod {
    const id = `pm_${Date.now().toString(36)}`;
    const created: SeedPayoutMethod = { ...data, id, createdAt: NOW };
    payoutMethods.push(created);
    return created;
  }
}

export const dataStore = new DataStore();
