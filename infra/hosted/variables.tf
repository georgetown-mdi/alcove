# Every account-specific value is a variable with no default, so a missing
# terraform.tfvars fails the plan rather than falling back to a guess.

variable "cloudflare_zone_id" {
  type        = string
  description = "The Cloudflare zone every name in this root is in. Its settings apply to every name in the zone, not only these."
}

variable "public_names" {
  type        = map(string)
  description = "The fully qualified name Cloudflare serves each deployment on, keyed production and staging."

  validation {
    condition     = toset(keys(var.public_names)) == toset(["production", "staging"])
    error_message = "public_names must have exactly the keys production and staging."
  }
}

variable "cloudflare_account_id" {
  type        = string
  description = "The Cloudflare account the Pages projects are in: the deploy workflows' CLOUDFLARE_ACCOUNT_ID secret."
}

variable "pages_project_name" {
  type        = string
  description = "The Cloudflare Pages project the hosted site is uploaded to: the deploy workflow's CLOUDFLARE_PAGES_PROJECT variable."
}

variable "site_pages_project_name" {
  type        = string
  description = "The Cloudflare Pages project the project site is uploaded to: site_deploy.yaml's CLOUDFLARE_SITE_PAGES_PROJECT variable."
}

variable "site_name" {
  type        = string
  description = "The name the project site is served on: the zone apex."
}

variable "demo_pages_project_name" {
  type        = string
  description = "The Cloudflare Pages project the demo site is uploaded to: the deploy workflow's CLOUDFLARE_DEMO_PAGES_PROJECT variable."
}

variable "demo_name" {
  type        = string
  description = "The name the demo site is served on."
}
