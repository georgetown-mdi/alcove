# The project's hosted environment, as OpenTofu

This root describes the project's own hosted deployment of the web application -- the Cloudflare Pages project that serves it, the project's two custom domains, the DNS records for them and the Cloudflare zone settings in front of both -- so the edge settings are code a reviewer reads, and a drift is a plan that is not empty. It is about that deployment alone; an agency hosting the web application itself starts from [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the Cloudflare account and zone and for the AWS account that holds the state.

## What it describes

| File            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.tf` | The Pages project (`cloudflare_pages_project.hosted`, direct upload, production branch `main`) and both public names as its custom domains (`cloudflare_pages_domain.production` and `.staging`). A proxied DNS record for each public name: the production record points at the project's `pages.dev` name, and the staging record at the `staging` branch alias, `staging.<project>.pages.dev`. Three zone settings: SSL/TLS mode `Full (strict)` (`ssl = strict`), Always Use HTTPS, and HSTS at `max-age=15552000` without `includeSubDomains` or preload -- the values [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#custom-domains-and-zone-settings) records |
| `variables.tf`  | Every account-specific value -- the AWS account id and region, the zone id, the Cloudflare account id, the Pages project name and the two public names -- with no default                                                                                                                                                                                                                                                                                                         |
| `providers.tf`  | The Cloudflare provider, and the AWS provider, which refuses to run against any account other than `aws_account_id`                                                                                                                                                                                                                                                                                                                                                                |

The DNS records and the Pages project have `prevent_destroy`, so a plan that would replace one fails instead of proposing it. The Pages project's deployments are outside this root: [`pages_deploy.yaml`](../../.github/workflows/pages_deploy.yaml) uploads them.

The root declares no AWS resource. The AWS provider stays while the state still holds AWS resources, so the apply that destroys them runs with the provider's account refusal in force; once the state holds no AWS resource, the provider, `aws_account_id` and `aws_region` can go, and the state bucket remains the only AWS dependency.

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the account ids included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: the AWS provider's default chain (`AWS_PROFILE`, or the `AWS_*` variables) and `CLOUDFLARE_API_TOKEN`. The AWS principal reads and writes the state object in the bucket and nothing else. The Cloudflare token needs Zone -> Zone Settings -> Read and Zone -> DNS -> Read on the one zone, and Account -> Cloudflare Pages -> Read on the account, to import and plan. An apply that changes a zone setting needs Zone Settings Edit, with DNS left at Read; one that changes a record is expected to need DNS Edit, and one that creates the Pages project or adds a domain Cloudflare Pages Edit, neither of which is measured. Without Zone Settings Read, the zone-setting imports fail with `403`. The permission list `GET /zones` returns is the account member's, not the token's, so it does not show what the token holds.

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

An apply that changes no Cloudflare resource -- the plan lists none -- runs with the Read-only token that imports and plans; Edit is needed only when the plan changes a record, a zone setting or the Pages project.

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
- **Confirmed:** each public name is a proxied `CNAME` with automatic TTL, the production name to the project's `pages.dev` name and the staging name to `staging.<project>.pages.dev`, and a custom domain on the `staging` branch alias serves the latest `staging` deployment.
- **Confirmed:** the Read-only token, with Cloudflare Pages Read added, plans the root with no change.
