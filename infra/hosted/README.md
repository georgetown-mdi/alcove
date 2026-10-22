# The project's hosted environment, as OpenTofu

This root describes the project's own hosted deployment of the web application -- the Cloudflare Pages project that serves it, the project's two custom domains, the DNS records for them and the Cloudflare zone settings in front of both -- so the edge settings are code a reviewer reads, and a drift is a plan that is not empty. Beside it, the project site's Pages project, served at the zone apex ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-project-site)), and the demo site's, a second deployment of the web application with a name of its own ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-demo-site)). It is about the project's own deployments alone; an agency hosting the web application itself starts from [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the Cloudflare account and zone and for the AWS account that holds the state.

## What it describes

| File            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.tf` | The Pages project (`cloudflare_pages_project.hosted`, direct upload, production branch `main`) and both public names as its custom domains (`cloudflare_pages_domain.production` and `.staging`). A proxied DNS record for each public name: the production record points at the project's `pages.dev` name, and the staging record at the `staging` branch alias, `staging.<project>.pages.dev`. Three zone settings: SSL/TLS mode `Full (strict)` (`ssl = strict`), Always Use HTTPS, and HSTS at `max-age=15552000` without `includeSubDomains` or preload -- the values [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#custom-domains-and-zone-settings) records. The project site's Pages project (`cloudflare_pages_project.site`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.site`), and a proxied record for that name (`cloudflare_dns_record.site_name`) pointing at the site project's `pages.dev` name. The demo site's Pages project (`cloudflare_pages_project.demo`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.demo`), and a proxied record for that name (`cloudflare_dns_record.demo_name`) pointing at the demo project's `pages.dev` name |
| `variables.tf`  | Every account-specific value -- the zone id, the Cloudflare account id, the three Pages project names, the two public names, the site's name and the demo site's name -- with no default                                                                                                                                                                                                                                                                                                         |
| `providers.tf`  | The Cloudflare provider, which reads its token from the environment |

The DNS records and the Pages projects have `prevent_destroy`, so a plan that would replace one fails instead of proposing it. The Pages projects' deployments are outside this root: [`pages_deploy.yaml`](../../.github/workflows/pages_deploy.yaml) uploads the web application's and the demo site's, and [`site_deploy.yaml`](../../.github/workflows/site_deploy.yaml) the project site's.

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the Cloudflare account id and the zone id included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: `CLOUDFLARE_API_TOKEN`, and the S3 state backend's AWS credentials, which the backend reads itself from its default chain (`AWS_PROFILE`, or the `AWS_*` variables). The AWS principal reads and writes the state object in the bucket and nothing else. With no AWS provider in this root, nothing checks which AWS account the credentials belong to; the backend's bucket name binds the state to the account that owns it. Two Cloudflare tokens keep reads apart from changes, and neither one's permissions are edited between runs. The plan token, for import, plan and drift checks, holds Zone -> Zone Settings -> Read and Zone -> DNS -> Read on the one zone, and Account -> Cloudflare Pages -> Read on the account. The apply token, used only for an apply whose plan changes a Cloudflare resource, holds the same scope with Edit: Zone -> Zone Settings -> Edit and Zone -> DNS -> Edit on the one zone, and Account -> Cloudflare Pages -> Edit on the account. Creating a record needed DNS Edit, and creating a Pages project and adding its domain needed Cloudflare Pages Edit, both measured on the first site apply (2026-10-12); changing a zone setting needs Zone Settings Edit. A token's policy shows only in the Cloudflare dashboard: a read through the token succeeds whatever Edit it lacks, and an apply missing one fails with `403` partway, after creating what it could (2026-10-22). Without Zone Settings Read, the zone-setting imports fail with `403`. The permission list `GET /zones` returns is the account member's, not the token's, so it does not show what the token holds.

`.gitignore` in this directory keeps `.terraform/`, state, plan files, tfvars and `backend.hcl` out of a commit. Commit `.terraform.lock.hcl`, which `tofu init` writes: it pins the provider builds a later run installs.

A plan prints the account ids and the resource names this repository otherwise keeps redacted. Do not paste plan output anywhere public.

## Applying

```sh
cd infra/hosted
cp backend.hcl.example backend.hcl            # fill in the state bucket
cp terraform.tfvars.example terraform.tfvars  # fill in every <...>
export AWS_PROFILE=<profile> CLOUDFLARE_API_TOKEN=<token>
tofu init -backend-config=backend.hcl
tofu plan -out=hosted.tfplan
tofu apply hosted.tfplan
```

`tofu init` and `tofu plan` run with the plan token. An apply whose plan changes a record, a zone setting or a Pages project runs with the apply token, exported as `CLOUDFLARE_API_TOKEN` for that apply alone; an apply whose plan lists no Cloudflare change runs with the plan token.

### Adopting the live resources

On a fresh state the resources already exist, so the first run adopts them into state rather than creating them: an apply that tried to create them would collide with the live ones. Import each once, after `tofu init` and before the first plan:

```sh
tofu import 'cloudflare_dns_record.public_name["staging"]' '<zone-id>/<record-id>'
tofu import 'cloudflare_dns_record.public_name["production"]' '<zone-id>/<record-id>'
tofu import cloudflare_zone_setting.ssl '<zone-id>/ssl'
tofu import cloudflare_zone_setting.always_use_https '<zone-id>/always_use_https'
tofu import cloudflare_zone_setting.hsts '<zone-id>/security_header'
```

The Pages project and its domains are imported the same way, under the same names; these import ids are not measured:

```sh
tofu import cloudflare_pages_project.hosted '<account-id>/<project-name>'
tofu import cloudflare_pages_domain.production '<account-id>/<project-name>/<production public name>'
tofu import cloudflare_pages_domain.staging '<account-id>/<project-name>/<staging public name>'
```

A record id is the `id` of `GET https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records?name=<public name>`.

The project site's project, domain and record were not imported: the apply created them. Before an apply that creates the record, list what the zone already holds at the apex with the same request, `name` set to the site's name. A record there of type `A`, `AAAA` or `CNAME` collides with the one this root creates; delete it, or import it as `cloudflare_dns_record.site_name` when it is already the `CNAME` this root declares.

The demo site's project, domain and record are created by an apply the same way, and the same request with `name` set to the demo site's name lists what would collide with its record. After that apply, check in the Cloudflare dashboard that Web Analytics is off for the demo project, as [PRIVACY.md](../../PRIVACY.md#hosted-web-application) records for the web application's project. Set the deploy variable `CLOUDFLARE_DEMO_PAGES_PROJECT` to the demo project's name only after both: the deploy workflow skips the demo upload while it is unset ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-demo-site)).

## Reading a plan for drift

Run `tofu plan -detailed-exitcode`. Its exit code is the answer: `0` the zone and the Pages project match this root, `2` they differ and the plan lists how, `1` the plan could not run. Read a `2` as follows:

- **`~` on a `cloudflare_zone_setting`, or on `content` or `proxied` of a record.** An edge setting or a record was changed in the dashboard. Apply to put it back, or change `cloudflare.tf` and apply, if the change was meant.
- **`~` on the Pages project or a domain.** A project setting was changed in the dashboard. The same choice.
- **Anything that must be replaced.** Stop and read it. `prevent_destroy` makes the plan fail for the records and the project rather than proposing it.

Above the planned changes, `Objects have changed outside of OpenTofu` lists what the refresh found changed, including a change the configuration then agrees with. Read it too.

## What the live account and zone do

Planning and applying this root against the live account and zone settles these of its assumptions:

- **Confirmed:** OpenTofu 1.10 or later (1.12.6), and the S3 backend with `use_lockfile`.
- **Confirmed:** the Cloudflare provider's v5 schema. In 5.25.0, `cloudflare_zone_setting` takes `setting_id` and `value`, and `cloudflare_dns_record` requires `ttl`. The HSTS `security_header` value as a `strict_transport_security` object imports with no difference, and the zone-setting import id is `<zone-id>/<setting_id>`.
- **Confirmed:** the zone settings. SSL/TLS mode `strict`, Always Use HTTPS on, and HSTS with no `includeSubDomains`, no preload and `nosniff` `false` all import with no difference.
- **Confirmed:** each public name is a proxied `CNAME` with automatic TTL, the production name to the project's `pages.dev` name and the staging name to `staging.<project>.pages.dev`, and the staging name is a custom domain on the `staging` branch alias; whether it serves the newest `staging` deployment or tracks production is checked on the next staging deploy that changes a web file.
- **Confirmed:** the Read-only token, with Cloudflare Pages Read added, plans the root with no change, measured before the project site's resources were added.
- **Confirmed:** the project site's first apply (2026-10-12). The plan was `cloudflare_pages_project.site`, `cloudflare_dns_record.site_name` and `cloudflare_pages_domain.site` to add, with 0 to change and 0 to destroy; the apply added the three, and a re-plan with `-detailed-exitcode` exited `0`. No record answered at the apex before the apply, and the apex record was accepted.
- **Not yet observed:** the site's name was still `initializing`, with validation `pending`, right after the apply. Whether it reaches `active` as a custom domain of the site project has not been observed.
