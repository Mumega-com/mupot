# mcpwp Commercial Service Catalog & Agency Execution Workflows

**Version:** 1.0  
**Author:** Chief of Staff (`cursor-mupot-setup`)  
**Ecosystem:** Mumega Inc. Commercialization & Mupot  
**Target:** Client Tenant Automation (`mcpwp` 239 WordPress Tools)

---

## 1. Executive Summary

`mcpwp` provides 239 model-context-protocol tools for programmatic control over WordPress, WooCommerce, Elementor, and Yoast/RankMath SEO. 

This document standardizes the **top 3 agency service packages** that Grok SEO scopes and Cursor Cloud / River execution seats fulfill for Mumega Inc. clients.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    COMMERCIAL SERVICE LOOP (mcpwp)                         │
├────────────────────────────────────────────────────────────────────────────┤
│ 1. INTAKE      | Grok SEO runs site audit & generates Mupot task with spec. │
│ 2. SCOPE       | Chief of Staff mounts client mcpwp vault connector.        │
│ 3. EXECUTE     | Cursor / River worker runs targeted mcpwp tool batch.      │
│ 4. VERIFY      | Independent gate verifies live HTTP 200 + AST diff.        │
│ 5. RECEIPT     | Tamper-evident receipt emitted to client & Stripe invoice. │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The 3 Standardized Service Packages

### Package A: SEO & Answer-Engine Meta Injection (`mcpwp-seo`)
* **Objective:** Audit and inject optimized title tags, meta descriptions, JSON-LD schema, and keyword-targeted headings across key landing pages.
* **Relevant `mcpwp` Tool Surface:**
  - `wp_get_posts` / `wp_get_pages`
  - `wp_update_post_meta` (Yoast `_yoast_wpseo_title`, `_yoast_wpseo_metadesc`, RankMath equivalents)
  - `wp_update_post` (Content and Heading hierarchy optimization)
* **Execution Recipe:**
  1. Fetch current page slug & metadata.
  2. Grok SEO generates keyword-aligned metadata.
  3. Worker calls `wp_update_post_meta` with new title and description.
  4. Worker requests live page HTML via HTTP and verifies `<title>` and `<meta name="description">` tags.
  5. Task lands with before/after diff in D1 task result.

---

### Package B: WooCommerce Catalog & Dynamic Pricing (`mcpwp-store`)
* **Objective:** Bulk update product prices, manage stock statuses, inject product attribute filters, and audit checkout flow.
* **Relevant `mcpwp` Tool Surface:**
  - `wc_get_products` / `wc_get_product_by_id`
  - `wc_update_product` (`regular_price`, `sale_price`, `stock_status`, `manage_stock`)
  - `wc_bulk_update_products`
  - `wc_get_orders` / `wc_get_reports`
* **Execution Recipe:**
  1. Read inventory sheet or pricing formula from project context.
  2. Query existing product IDs and prices via `wc_get_products`.
  3. Execute atomic price updates with `wc_update_product`.
  4. Verify updated product prices on the live store endpoint.
  5. Emit completion receipt with SKU list and price delta summary.

---

### Package C: Elementor Landing Page & Content Synthesis (`mcpwp-content`)
* **Objective:** Programmatically inject structured blog posts, hero sections, and FAQ blocks formatted for Elementor into WordPress.
* **Relevant `mcpwp` Tool Surface:**
  - `wp_create_post` / `wp_update_post`
  - `elementor_get_data` / `elementor_update_data`
  - `wp_upload_media` (from R2 asset cache)
* **Execution Recipe:**
  1. Generate structured markdown / HTML with embedded FAQ JSON-LD schema.
  2. Create draft post using `wp_create_post(status='draft')`.
  3. Upload referenced assets via `wp_upload_media`.
  4. Submit for client review gate. Upon approval, update post status to `publish`.
  5. Record live URL and verification receipt in D1.

---

## 3. Governance, Secrets & Non-Negotiables

1. **Zero Secret Leaks:** Client WordPress application passwords live exclusively in Mupot's encrypted connector vault (`src/connectors/crypto.ts`). Model prompts only receive tool call execution handles.
2. **Pre-Flight Site Health:** Every `mcpwp` flight must verify `wp_get_site_health` or a basic ping before applying mutating updates.
3. **No Direct Production Destroy:** Bulk deletions (`wp_delete_post`, `wc_delete_product`) are strictly capability-gated to `admin` and require an explicit human confirmation ticket.
