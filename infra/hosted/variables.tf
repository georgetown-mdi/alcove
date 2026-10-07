# Every account-specific value is a variable with no default, so a missing
# terraform.tfvars fails the plan rather than falling back to a guess.

variable "cloudflare_zone_id" {
  type        = string
  description = "The Cloudflare zone both public names are in. Its settings apply to every name in the zone, not only these two."
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
  description = "The Cloudflare account the Pages project is in: the deploy workflow's CLOUDFLARE_ACCOUNT_ID secret."
}

variable "pages_project_name" {
  type        = string
  description = "The Cloudflare Pages project the hosted site is uploaded to: the deploy workflow's CLOUDFLARE_PAGES_PROJECT variable."
}
