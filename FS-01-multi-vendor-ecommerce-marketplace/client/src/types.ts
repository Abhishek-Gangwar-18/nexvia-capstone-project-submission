/**
 * Shapes of the main API objects used by the client. They follow the server's Mongoose models.
 * Each one allows extra fields (`[key: string]: any`) because many endpoints add computed or
 * populated fields on top of the stored document.
 */
export type Role = 'customer' | 'vendor' | 'admin';
export type Id = string;

export interface Address {
  _id?: Id;
  label?: string;
  fullName: string;
  phone: string;
  line1?: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
  isDefault?: boolean;
  [key: string]: any;
}

export interface User {
  id: Id;
  _id?: Id;
  name: string;
  email: string;
  role: Role;
  phone?: string;
  avatar?: string;
  addresses?: Address[];
  wishlist?: Id[];
  status?: 'active' | 'blocked';
  createdAt?: string;
  vendor?: Vendor | null;
  [key: string]: any;
}

export interface Blocked {
  reason?: string;
  blockedAt?: string;
}

export interface Category {
  _id: Id;
  name: string;
  slug?: string;
  image?: string;
  group?: string;
  isActive?: boolean;
  [key: string]: any;
}

export interface ProductImage {
  url: string;
  key?: string;
  [key: string]: any;
}

export interface Product {
  _id: Id;
  title: string;
  description?: string;
  brand?: string;
  category?: Category | Id;
  price: number;
  mrp?: number;
  stock: number;
  sku?: string;
  images?: ProductImage[];
  thumbnail?: string;
  tags?: string[];
  specs?: { label: string; value: string }[];
  rating?: number;
  numRatings?: number;
  sold?: number;
  isActive?: boolean;
  vendor?: Vendor | Id;
  storeName?: string;
  [key: string]: any;
}

export type VendorStatus = 'pending' | 'approved' | 'suspended' | 'rejected';

export interface Vendor {
  _id: Id;
  storeName: string;
  slug?: string;
  tagline?: string;
  description?: string;
  logo?: string;
  banner?: string;
  email?: string;
  phone?: string;
  status?: VendorStatus;
  commissionRate?: number;
  rating?: number;
  numRatings?: number;
  [key: string]: any;
}

export type OrderStatus = 'pending_payment' | 'placed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | string;
export type PackageStatus = 'pending' | 'placed' | 'packed' | 'shipped' | 'delivered' | 'cancelled' | string;

export interface OrderItem {
  product: Id;
  title: string;
  image?: string;
  price: number;
  quantity: number;
  total: number;
  [key: string]: any;
}

export interface OrderPackage {
  _id: Id;
  vendor: Vendor | Id;
  items: OrderItem[];
  subtotal: number;
  discount?: number;
  total: number;
  status: PackageStatus;
  timeline?: { status: string; note?: string; at: string }[];
  [key: string]: any;
}

export interface Order {
  _id: Id;
  orderNumber: string;
  packages: OrderPackage[];
  shippingAddress?: Address;
  pricing: { subtotal: number; discount: number; shipping: number; total: number };
  payment?: { provider?: string; status?: string; currency?: string; [key: string]: any };
  status: OrderStatus;
  createdAt?: string;
  [key: string]: any;
}

export interface CartLine {
  product: Product;
  quantity: number;
  [key: string]: any;
}

export interface Review {
  _id: Id;
  authorName?: string;
  rating: number;
  title?: string;
  comment?: string;
  photos?: { url: string }[];
  verified?: boolean;
  helpfulCount?: number;
  createdAt?: string;
  [key: string]: any;
}

export interface Coupon {
  _id: Id;
  code: string;
  description?: string;
  type: 'percent' | 'flat' | string;
  value: number;
  minOrder?: number;
  maxDiscount?: number;
  expiresAt?: string;
  isActive?: boolean;
  [key: string]: any;
}

/** Error thrown by axios calls to the API. */
export interface ApiError extends Error {
  response?: { status: number; data?: { message?: string; code?: string; details?: any; [key: string]: any } };
}

// Every React Query error in this app is an axios error from the API.
declare module '@tanstack/react-query' {
  interface Register {
    defaultError: ApiError;
  }
}
