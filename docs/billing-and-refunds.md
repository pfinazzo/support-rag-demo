# Billing & Refunds

Example Cloud billing covers subscription plans, prorated upgrades, refunds, invoices, and failed payments. Use this guide when a customer asks about charges, plan changes, or payment errors.

## Subscription Plans

Example Cloud offers three paid plans. All plans renew monthly or annually based on the customer's choice at checkout.

### Starter Plan

The Starter plan is $29 per month (or $290 per year). It includes 5 seats, 10,000 API requests per day, and email support with a 1-business-day response target. This plan is ideal for small teams evaluating Example Cloud.

### Growth Plan

The Growth plan is $99 per month (or $990 per year). It includes 25 seats, 100,000 API requests per day, priority email support, and SSO. Most mid-size customers run on Growth.

### Enterprise Plan

The Enterprise plan starts at $499 per month and is quoted annually. It includes unlimited seats (subject to contract), custom rate limits, a dedicated success manager, SAML SSO, and a signed DPA. Contact sales@examplecloud.example for Enterprise quotes.

## Proration on Plan Changes

When a customer upgrades mid-cycle, Example Cloud charges a prorated amount for the remainder of the current billing period. Downgrades take effect at the next renewal so the customer keeps paid features until the period ends. Unused time on the old plan is credited as account balance, not as a cash refund.

To change a plan: open **Settings → Billing → Change Plan**, pick the new tier, and confirm. The confirmation screen shows the exact prorated charge before you submit.

## Refund Policy

Example Cloud offers a **14-day refund policy** on first-time annual subscriptions. Monthly subscriptions are non-refundable after the first 48 hours, except when required by local consumer law.

To request a refund within the 14-day window, email billing@examplecloud.example with the invoice number. Approved refunds appear on the original payment method within 5–10 business days. Partial refunds are not offered for unused seats.

## Downloading PDF Invoices

Every successful charge produces a PDF invoice. To download one:

1. Go to **Settings → Billing → Invoices**.
2. Find the charge by date or invoice ID (format `INV-YYYY-######`).
3. Click **Download PDF**.

Invoices include the company legal name, tax ID (if provided), line items, and payment method last four digits. For a consolidated annual statement, reply to any invoice email and ask for a year-end summary.

## Failed Payments (ERR_PAYMENT_402)

When a renewal charge is declined, the billing system emits error code **ERR_PAYMENT_402**. Common causes are an expired card, insufficient funds, or a bank fraud hold.

### What customers see

The dashboard shows a red banner: "Payment failed (ERR_PAYMENT_402). Update your card to avoid service interruption." Email alerts go to every billing admin on the workspace.

### How to resolve ERR_PAYMENT_402

1. Open **Settings → Billing → Payment Methods**.
2. Add a new card or update the existing one.
3. Click **Retry failed payment**.

If the retry succeeds, the ERR_PAYMENT_402 banner clears within a few minutes. If it fails again, contact the card issuer and then email billing@examplecloud.example with the last four digits and approximate charge time. Workspaces stay in a 7-day grace period after the first ERR_PAYMENT_402 before features are restricted.
