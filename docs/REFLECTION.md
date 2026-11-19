# Individual reflection

> **Template — write the answers in your own words.** The brief asks each intern for a personal reflection on what they
> learned and what they owned, so reviewers expect your voice, not a generated text. The facts below are there to jog
> your memory; replace every _italic prompt_ with your answer and delete this note.

**Name:** _your name_
**Track:** Full-Stack Development · **Project:** Vendora (multi-vendor marketplace) · **Period:** 20 Oct – 20 Nov 2026

---

## 1. What I owned

Parts of the project that were mine. Tick or edit; add what's missing.

- [ ] Planning: roles, database schema, API list (`docs/ARCHITECTURE.md`)
- [ ] Authentication: access/refresh tokens, sessions per device, role-based access, blocked accounts
- [ ] Seller onboarding, product management, image uploads to AWS S3
- [ ] Search with Elasticsearch (typo tolerance, synonyms, facets, typeahead) and the MongoDB fallback
- [ ] Cart, checkout, stock reservation, order lifecycle (placed → packed → shipped → delivered), Redis caching
- [ ] Stripe payments, refunds, returns, Connect payouts after the return window, reconciliation
- [ ] Reviews, coupons, PDF invoices, admin analytics
- [ ] Docker setup (API + web images, nginx, compose)
- [ ] TypeScript migration (161 files, 0 type errors)
- [ ] Deployment (Render + Vercel, Elastic Cloud for live search), README and docs, tests

_Which of these was the part you're proudest of, and why?_

## 2. What I learned

### Technical

_Two or three things you can do now that you couldn't on 20 October. Be specific: for example, how a refresh token
rotates, why stock needs an atomic update, how Stripe Connect transfers work, how Elasticsearch fuzziness works, or
how nginx forwards requests in Docker._

### Engineering practice

_What did you learn about working on a real project? For example: writing tests for money-handling code, keeping
commits clean, documenting decisions, handling a changing brief (Razorpay → Stripe, Docker and TypeScript added
late), checking production config at startup._

## 3. Challenges

_Pick the one or two hardest problems. For each: what went wrong, how you found the cause, and how you fixed it._

Ideas from the project history, if they match your experience:
- A refund or payout that could have run twice under a retry.
- Stock going wrong when two people check out at once.
- Atlas DNS (`querySrv ECONNREFUSED`) on Windows.
- The Stripe publishable/secret key mix-up that blanked the checkout.
- The `address.js` / `Address.js` case mismatch that would only crash on Linux.

## 4. What I'd do differently

_With hindsight: what would you change in your approach, planning or design?_

## 5. Next steps for me

_What do you want to learn or build next because of this project?_
