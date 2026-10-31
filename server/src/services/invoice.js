import PDFDocument from 'pdfkit';
import { PLATFORM_NAME } from '../config/env.js';

const COLORS = { brand: '#4f46e5', ink: '#111827', muted: '#6b7280', line: '#e5e7eb', soft: '#f5f5ff' };

// The built-in PDF fonts have no ₹ glyph, so amounts are written as "Rs.".
const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** Renders an order invoice as a PDF and pipes it into the HTTP response. */
export function streamInvoice(order, customer, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${order.orderNumber}`, Author: PLATFORM_NAME } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.orderNumber}.pdf"`);
  doc.pipe(res);

  const left = 48;
  const right = doc.page.width - 48;
  const width = right - left;
  let y = 0;

  const ensureSpace = (needed) => {
    if (y + needed > doc.page.height - 80) {
      doc.addPage();
      y = 48;
    }
  };

  // Header band
  doc.rect(0, 0, doc.page.width, 112).fill(COLORS.brand);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26).text(PLATFORM_NAME, left, 34);
  doc.font('Helvetica').fontSize(10).fillColor('#e0e7ff').text('Multi-vendor marketplace', left, 66);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('TAX INVOICE', left, 34, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#e0e7ff');
  doc.text(`Invoice no. INV-${order.orderNumber}`, left, 60, { width, align: 'right' });
  doc.text(`Order date ${date(order.placedAt || order.createdAt)}`, left, 75, { width, align: 'right' });

  // Parties
  y = 140;
  const colWidth = width / 3;
  // Lines flow by their measured height, so one that wraps (a long payment reference) pushes the next
  // down instead of overlapping it. A line can be { text, size, color } for smaller/muted text.
  const block = (title, lines, x) => {
    const w = colWidth - 12;
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), x, y, { width: w, characterSpacing: 1 });
    let lineY = y + 16;
    for (const line of lines.filter(Boolean)) {
      const { text, size = 10, color = COLORS.ink } = typeof line === 'string' ? { text: line } : line;
      doc.fillColor(color).font('Helvetica').fontSize(size);
      doc.text(text, x, lineY, { width: w, lineGap: 1 });
      lineY += doc.heightOfString(text, { width: w, lineGap: 1 }) + 2;
    }
    return lineY;
  };
  const a = order.shippingAddress || {};
  const bottoms = [
    block('Billed to', [customer?.name, customer?.email, a.phone], left),
    block('Ship to', [a.fullName, a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`], left + colWidth),
    block(
      'Payment',
      [
        order.payment.provider === 'stripe' ? 'Stripe' : 'Test gateway',
        `Status: ${order.payment.status.toUpperCase()}`,
        order.payment.paidAt ? `Paid on ${date(order.payment.paidAt)}` : null,
        order.payment.paymentId ? { text: 'Reference', size: 8, color: COLORS.muted } : null,
        order.payment.paymentId ? { text: order.payment.paymentId, size: 8 } : null,
      ],
      left + colWidth * 2,
    ),
  ];
  y = Math.max(...bottoms) + 24;

  // Packages
  const cols = { item: left + 10, qty: left + width * 0.6, price: left + width * 0.7, total: left + width * 0.84 };
  for (const pkg of order.packages) {
    ensureSpace(90);
    doc.roundedRect(left, y, width, 26, 6).fill(COLORS.soft);
    doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(10).text(`Sold by ${pkg.storeName}`, cols.item, y + 8);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(pkg.status.toUpperCase(), left, y + 9, { width: width - 10, align: 'right' });
    y += 36;

    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8);
    doc.text('ITEM', cols.item, y);
    doc.text('QTY', cols.qty, y);
    doc.text('PRICE', cols.price, y);
    doc.text('AMOUNT', cols.total, y, { width: right - cols.total, align: 'right' });
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(COLORS.line).lineWidth(1).stroke();
    y += 8;

    doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
    for (const item of pkg.items) {
      ensureSpace(24);
      doc.fillColor(COLORS.ink).text(clip(item.title, 52), cols.item, y, { width: cols.qty - cols.item - 10 });
      doc.text(String(item.quantity), cols.qty, y);
      doc.text(money(item.price), cols.price, y);
      doc.text(money(item.total), cols.total, y, { width: right - cols.total, align: 'right' });
      y += 20;
    }
    if (pkg.discount > 0) {
      doc.fillColor('#059669').text('Coupon discount', cols.item, y);
      doc.text(`- ${money(pkg.discount)}`, cols.total, y, { width: right - cols.total, align: 'right' });
      y += 20;
    }
    y += 8;
  }

  // Totals
  ensureSpace(130);
  const boxX = left + width * 0.55;
  const boxW = right - boxX;
  doc.moveTo(boxX, y).lineTo(right, y).strokeColor(COLORS.line).stroke();
  y += 10;
  const row = (label, value, { bold = false, color = COLORS.ink } = {}) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(color);
    doc.text(label, boxX, y, { width: boxW / 2 });
    doc.text(value, boxX + boxW / 2, y, { width: boxW / 2, align: 'right' });
    y += bold ? 22 : 18;
  };
  row('Subtotal', money(order.pricing.subtotal));
  if (order.pricing.discount > 0) row(`Discount${order.coupon?.code ? ` (${order.coupon.code})` : ''}`, `- ${money(order.pricing.discount)}`, { color: '#059669' });
  row('Shipping', order.pricing.shipping ? money(order.pricing.shipping) : 'FREE');
  doc.moveTo(boxX, y).lineTo(right, y).strokeColor(COLORS.line).stroke();
  y += 8;
  row('Grand total', money(order.pricing.total), { bold: true, color: COLORS.brand });

  // Footer (bottom margin is lifted temporarily so the footer doesn't trigger a page break)
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
  doc.text(
    `Prices are inclusive of applicable taxes. Each package is sold and fulfilled by the listed seller; ${PLATFORM_NAME} acts as the marketplace facilitator. This is a computer-generated invoice and does not require a signature.`,
    left,
    doc.page.height - 64,
    { width, align: 'center' },
  );
  doc.page.margins.bottom = bottomMargin;

  doc.end();
}
