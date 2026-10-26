locals {
  www_name = "www.${var.site_name}"

  # Every name in the zone that answers with an address, and so could be taken
  # for a mail domain: each states that it sends and receives no mail.
  mail_refusing_names = toset(concat(
    [var.site_name, local.www_name, var.demo_name],
    values(var.public_names),
    tolist(var.dns_only_names),
  ))

  # The certificate authorities that issue for names in the zone. A CAA set
  # missing one in use fails that name's next renewal, and nothing reports it
  # until the certificate expires.
  caa_issuers = toset(["letsencrypt.org", "pki.goog"])
}

# www has no site of its own: the edge answers every request on it with the
# redirect below, so the record only has to be proxied. 100:: is the IPv6
# discard prefix, so nothing answers behind it.
resource "cloudflare_dns_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = local.www_name
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

# The zone's entry point for the redirect phase. The zone has one per phase, so
# every redirect rule for the zone belongs in this resource.
resource "cloudflare_ruleset" "redirects" {
  zone_id = var.cloudflare_zone_id
  name    = "Zone redirects"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"

  rules = [
    {
      ref         = "www_to_apex"
      description = "www to the project site, same path and query"
      expression  = "(http.host eq \"${local.www_name}\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://${var.site_name}\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

# Null MX (RFC 7505): no host accepts mail for the name.
resource "cloudflare_dns_record" "null_mx" {
  for_each = local.mail_refusing_names

  zone_id  = var.cloudflare_zone_id
  name     = each.value
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 1
}

# No host sends mail for the name.
resource "cloudflare_dns_record" "spf" {
  for_each = local.mail_refusing_names

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "TXT"
  content = "v=spf1 -all"
  ttl     = 1
}

# Reject mail claiming any name in the zone. A subdomain policy defaults to
# this one (RFC 7489, 6.3), so the apex record covers every name. No report
# address: the zone receives no mail.
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.site_name}"
  type    = "TXT"
  content = "v=DMARC1; p=reject"
  ttl     = 1
}

# At the apex, a CAA record governs every name below it that has none of its
# own (RFC 8659, 3), the wildcard on the zone's edge certificate included.
resource "cloudflare_dns_record" "caa" {
  for_each = local.caa_issuers

  zone_id = var.cloudflare_zone_id
  name    = var.site_name
  type    = "CAA"
  ttl     = 1
  data = {
    flags = 0
    tag   = "issue"
    value = each.value
  }
}

# Turning DNSSEC off while the registrar still publishes the DS record makes
# every name in the zone fail validation: remove the DS record first
# (README.md, DNSSEC).
resource "cloudflare_zone_dnssec" "zone" {
  zone_id             = var.cloudflare_zone_id
  status              = "active"
  dnssec_multi_signer = false
  dnssec_presigned    = false
  dnssec_use_nsec3    = false

  lifecycle {
    prevent_destroy = true
  }
}
