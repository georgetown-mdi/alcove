# The Cloudflare token comes from the operator's environment as
# CLOUDFLARE_API_TOKEN. It is not a variable of this root, so it cannot land in
# a tfvars file.

provider "cloudflare" {}
