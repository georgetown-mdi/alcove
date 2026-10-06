# Each public name is proxied, so a visitor reaches Cloudflare's edge and only
# the edge reaches the origin.
resource "cloudflare_dns_record" "public_name" {
  for_each = var.environments

  zone_id = var.cloudflare_zone_id
  name    = each.value.public_name
  type    = "CNAME"
  # Elastic Beanstalk reports the name in mixed case; the live record holds it
  # lowercase. production_origin moves the production name to Pages.
  content = (
    each.key == "production" && var.production_origin == "pages"
    ? cloudflare_pages_project.hosted.subdomain
    : lower(aws_elastic_beanstalk_environment.hosted[each.key].cname)
  )
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

# Direct upload: the project has no Git source, and pages_deploy.yaml uploads
# each build with wrangler. A deployment to the production branch is the
# production deployment; one to any other branch, staging included, is a
# preview on that branch's alias.
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
  name         = var.environments["production"].public_name
}
