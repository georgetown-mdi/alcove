locals {
  pages_names = {
    production = cloudflare_pages_project.hosted.subdomain
    staging    = "staging.${cloudflare_pages_project.hosted.subdomain}"
  }
}

# Each public name is proxied, so a visitor reaches Cloudflare's edge and only
# the edge reaches Pages: the production name at the project's pages.dev name,
# the staging name at the staging branch alias.
resource "cloudflare_dns_record" "public_name" {
  for_each = var.public_names

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "CNAME"
  content = local.pages_names[each.key]
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 15552000
      include_subdomains = false
      preload            = false
      nosniff            = false
    }
  }
}

# Direct upload: the project has no Git source, and the workflows upload each
# build with wrangler, pages_deploy.yaml from main and staging and
# release.yaml from a release tag to the production branch. A deployment to the production
# branch is the production deployment; one to any other branch, staging
# included, is a preview on that branch's alias.
resource "cloudflare_pages_project" "hosted" {
  account_id        = var.cloudflare_account_id
  name              = var.pages_project_name
  production_branch = "main"

  lifecycle {
    prevent_destroy = true
  }
}

# The production public name on the project. It verifies once the record above
# points at the project's pages.dev name.
resource "cloudflare_pages_domain" "production" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.hosted.name
  name         = var.public_names["production"]
}

# The staging public name on the project, served from the staging branch alias
# its record points at.
resource "cloudflare_pages_domain" "staging" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.hosted.name
  name         = var.public_names["staging"]
}

# The project site, built from docs/, in a Pages project of its own so it
# shares no origin with the web app. Direct upload, as above: site_deploy.yaml
# uploads each build, a deployment to main is the production one, and one to
# staging is a preview on that branch's alias.
resource "cloudflare_pages_project" "site" {
  account_id        = var.cloudflare_account_id
  name              = var.site_pages_project_name
  production_branch = "main"

  lifecycle {
    prevent_destroy = true
  }
}

# The site's name, the zone apex, proxied to the site project's pages.dev name.
# A CNAME at the apex is served by Cloudflare's CNAME flattening.
resource "cloudflare_dns_record" "site_name" {
  zone_id = var.cloudflare_zone_id
  name    = var.site_name
  type    = "CNAME"
  content = cloudflare_pages_project.site.subdomain
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

# The site's name on the site project. It verifies once the record above
# points at the project's pages.dev name.
resource "cloudflare_pages_domain" "site" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.site.name
  name         = var.site_name
}

# The demo site, a second deployment of the web app, in a Pages project of its
# own. Direct upload, as above: the same jobs upload the demo build, a
# deployment to main is the production one, and one to staging is a preview on
# that branch's alias.
resource "cloudflare_pages_project" "demo" {
  account_id        = var.cloudflare_account_id
  name              = var.demo_pages_project_name
  production_branch = "main"

  lifecycle {
    prevent_destroy = true
  }
}

# The demo site's name, proxied to the demo project's pages.dev name. No name
# points at its staging alias.
resource "cloudflare_dns_record" "demo_name" {
  zone_id = var.cloudflare_zone_id
  name    = var.demo_name
  type    = "CNAME"
  content = cloudflare_pages_project.demo.subdomain
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

# The demo site's name on the demo project. It verifies once the record above
# points at the project's pages.dev name.
resource "cloudflare_pages_domain" "demo" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.demo.name
  name         = var.demo_name
}
