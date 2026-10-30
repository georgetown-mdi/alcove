# The project's hosted environment, as OpenTofu

This root describes the project's own hosted deployment of the web application -- the Cloudflare Pages project that serves it, the project's two custom domains, the DNS records for them and the Cloudflare zone settings in front of both -- so the edge settings are code a reviewer reads, and a drift is a plan that is not empty. Beside it, the project site's Pages project, served at the zone apex ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-project-site)), and the demo site's, a second deployment of the web application with a name of its own ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-demo-site)). The zone's own records sit beside them: the `www` redirect, the records stating that no name in the zone sends or receives mail, the CAA records, and DNSSEC. It is about the project's own deployments alone; an agency hosting the web application itself starts from [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the Cloudflare account and zone and for the AWS account that holds the state.

## What it describes

| File            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.tf` | The Pages project (`cloudflare_pages_project.hosted`, direct upload, production branch `main`) and both public names as its custom domains (`cloudflare_pages_domain.production` and `.staging`). A proxied DNS record for each public name: the production record points at the project's `pages.dev` name, and the staging record at the `staging` branch alias, `staging.<project>.pages.dev`. Three zone settings: SSL/TLS mode `Full (strict)` (`ssl = strict`), Always Use HTTPS, and HSTS at `max-age=15552000` without `includeSubDomains` or preload -- the values [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#custom-domains-and-zone-settings) records. The project site's Pages project (`cloudflare_pages_project.site`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.site`), and a proxied record for that name (`cloudflare_dns_record.site_name`) pointing at the site project's `pages.dev` name. The demo site's Pages project (`cloudflare_pages_project.demo`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.demo`), and a proxied record for that name (`cloudflare_dns_record.demo_name`) pointing at the demo project's `pages.dev` name |
| `zone.tf`       | The zone's records outside any one site. A proxied record for `www` (`cloudflare_dns_record.www`, `AAAA` to the discard address `100::`) and the zone's entry point for the redirect phase (`cloudflare_ruleset.redirects`), whose one rule answers every request on `www` with a `301` to the same path and query on the site's name. On every name that answers with an address -- the apex, `www`, the two public names, the demo site's name and the DNS-only names -- a null MX (`cloudflare_dns_record.null_mx`, RFC 7505) and SPF `v=spf1 -all` (`cloudflare_dns_record.spf`); DMARC `v=DMARC1; p=reject` at `_dmarc` (`cloudflare_dns_record.dmarc`), with no report address. CAA `issue` records at the apex for each certificate authority that issues for a name in the zone (`cloudflare_dns_record.caa`, see [Certificate authorities](#certificate-authorities)). DNSSEC (`cloudflare_zone_dnssec.zone`) |
| `variables.tf`  | Every account-specific value -- the zone id, the Cloudflare account id, the three Pages project names, the two public names, the site's name, the demo site's name and the DNS-only names (the relay host's, whose address records this root does not declare) -- with no default                                                                                                                                                                                                                                                                                                         |
| `providers.tf`  | The Cloudflare provider, which reads its token from the environment |

The records that serve a name, the Pages projects and DNSSEC have `prevent_destroy`, so a plan that would replace one fails instead of proposing it. The mail and CAA records do not: removing a name or a certificate authority from the list one comes from removes its record. The Pages projects' deployments are outside this root: [`pages_deploy.yaml`](../../.github/workflows/pages_deploy.yaml) uploads the web application's and the demo site's production deployments from a push to `main` and their `staging` previews from a push to `staging`, [`release.yaml`](../../.github/workflows/release.yaml) redeploys production from a release tag, and [`site_deploy.yaml`](../../.github/workflows/site_deploy.yaml) the project site's.

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the Cloudflare account id and the zone id included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: `CLOUDFLARE_API_TOKEN`, and the S3 state backend's AWS credentials, which the backend reads itself from its default chain (`AWS_PROFILE`, or the `AWS_*` variables). The AWS principal reads and writes the state object in the bucket and nothing else. With no AWS provider in this root, nothing checks which AWS account the credentials belong to; the backend's bucket name binds the state to the account that owns it. Two Cloudflare tokens keep reads apart from changes, and neither one's permissions are edited between runs:
  - The plan token, for import, plan and drift checks, holds Zone -> Zone Settings -> Read, Zone -> DNS -> Read and Zone -> Single Redirect -> Read on the one zone, and Account -> Cloudflare Pages -> Read on the account.
  - The apply token, used only for an apply whose plan changes a Cloudflare resource, holds the same scope with Edit: Zone -> Zone Settings -> Edit, Zone -> DNS -> Edit and Zone -> Single Redirect -> Edit on the one zone, and Account -> Cloudflare Pages -> Edit on the account.
  - Single Redirect is for `cloudflare_ruleset.redirects`; DNSSEC needs nothing beyond DNS ([measured](#what-the-live-account-and-zone-do) on 2026-10-26: the DNSSEC import ran under DNS Read). A plan of the ruleset sends its rules to the API as a dry run (`POST .../rulesets?dry_run=true`, measured against a stand-in API on 2026-10-26); a refused dry run is a plan warning, not an error.

  Creating a record needed DNS Edit, and creating a Pages project and adding its domain needed Cloudflare Pages Edit, both measured on the first site apply (2026-10-12); changing a zone setting needs Zone Settings Edit. A token's policy shows only in the Cloudflare dashboard: a read through the token succeeds whatever Edit it lacks, and an apply missing one fails with `403` partway, after creating what it could (2026-10-22). Without Zone Settings Read, the zone-setting imports fail with `403`. The permission list `GET /zones` returns is the account member's, not the token's, so it does not show what the token holds.

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

`tofu init` and `tofu plan` run with the plan token. An apply whose plan changes a record, a zone setting, the redirect ruleset, DNSSEC or a Pages project runs with the apply token, exported as `CLOUDFLARE_API_TOKEN` for that apply alone; an apply whose plan lists no Cloudflare change runs with the plan token.

### Adopting the live resources

On a fresh state the resources already exist, so the first run adopts them into state rather than creating them: an apply that tried to create them would collide with the live ones. Import each once, after `tofu init` and before the first plan:

```sh
tofu import 'cloudflare_dns_record.public_name["staging"]' '<zone-id>/<record-id>'
tofu import 'cloudflare_dns_record.public_name["production"]' '<zone-id>/<record-id>'
tofu import cloudflare_zone_setting.ssl '<zone-id>/ssl'
tofu import cloudflare_zone_setting.always_use_https '<zone-id>/always_use_https'
tofu import cloudflare_zone_setting.hsts '<zone-id>/security_header'
```

The Pages project and its domains are imported the same way, under the same names, with these import ids, measured on the web application's project on 2026-10-22:

```sh
tofu import cloudflare_pages_project.hosted '<account-id>/<project-name>'
tofu import cloudflare_pages_domain.production '<account-id>/<project-name>/<production public name>'
tofu import cloudflare_pages_domain.staging '<account-id>/<project-name>/<staging public name>'
```

Renaming a Pages project is a dashboard step, not a change to `pages_project_name` alone: the provider replaces a project whose `name` changes, which `prevent_destroy` refuses. Rename the project in the dashboard, set the deploy variable that names it on both environments before any deploy runs, then `tofu state rm` the project and its domains and import them again under the new name with the ids above, and update `terraform.tfvars`; the next plan has no changes. The rename keeps the project's `pages.dev` address, so the records pointing at it need no change: the web application's project, `alcove-app`, answers at `alcove-link.pages.dev`, the address it was created with.

A record id is the `id` of `GET https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records?name=<public name>`.

The project site's project, domain and record were not imported: the apply created them. Before an apply that creates the record, list what the zone already holds at the apex with the same request, `name` set to the site's name. A record there of type `A`, `AAAA` or `CNAME` collides with the one this root creates; delete it, or import it as `cloudflare_dns_record.site_name` when it is already the `CNAME` this root declares.

The demo site's project, domain and record are created by an apply the same way, and the same request with `name` set to the demo site's name lists what would collide with its record. After that apply, check in the Cloudflare dashboard that Web Analytics is off for the demo project, as [PRIVACY.md](../../PRIVACY.md#hosted-web-application) records for the web application's project. Set the deploy variable `CLOUDFLARE_DEMO_PAGES_PROJECT` to the demo project's name only after both: the deploy workflow skips the demo upload while it is unset ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-demo-site)).

The zone's records in `zone.tf` are created by an apply, except DNSSEC, which was already on (2026-10-26, below) and is imported. The id forms are the ones the provider's import names when given a wrong one (5.25.0, 2026-10-26):

```sh
tofu import cloudflare_zone_dnssec.zone '<zone-id>'
tofu import cloudflare_ruleset.redirects 'zones/<zone-id>/<ruleset-id>'
```

Import the ruleset only when the zone already has an entry point for the redirect phase, which `GET .../zones/<zone-id>/rulesets/phases/http_request_dynamic_redirect/entrypoint` answers; a `404` there means none, and the apply creates it. An entry point that already holds rules made in the dashboard loses them to the apply unless they are first added to `cloudflare_ruleset.redirects`. Before the apply, list the zone's `MX`, `TXT` and `CAA` records and the records at `www` (the same `dns_records` request, with `type` or `name` set): an `MX`, an SPF or DMARC `TXT`, or a `CAA` record already there is a second policy beside the one this root declares, and a record at `www` collides with `cloudflare_dns_record.www`. Delete each, or import it under the name this root gives it.

## Reading a plan for drift

Run `tofu plan -detailed-exitcode`. Its exit code is the answer: `0` the zone and the Pages project match this root, `2` they differ and the plan lists how, `1` the plan could not run. Read a `2` as follows:

- **`~` on a `cloudflare_zone_setting`, or on `content` or `proxied` of a record.** An edge setting or a record was changed in the dashboard. Apply to put it back, or change `cloudflare.tf` and apply, if the change was meant.
- **`~` on the Pages project or a domain.** A project setting was changed in the dashboard. The same choice.
- **`~` on `cloudflare_ruleset.redirects` or `cloudflare_zone_dnssec.zone`.** A redirect rule or the DNSSEC setting was changed in the dashboard. The same choice; for DNSSEC, read [DNSSEC](#dnssec) first.
- **Anything that must be replaced.** Stop and read it. `prevent_destroy` makes the plan fail for the records and the project rather than proposing it.

Above the planned changes, `Objects have changed outside of OpenTofu` lists what the refresh found changed, including a change the configuration then agrees with. Read it too.

## Certificate authorities

The CAA records at the apex name every certificate authority allowed to issue for a name in the zone. Three kinds of certificate are issued for names in it, and the CAA set has to admit each one's authority:

- **Cloudflare's edge certificate** for the zone, which covers the apex and `*.<zone>`, `www` among them.
- **The Pages custom-domain certificates** for the apex, the two public names and the demo site's name.
- **The relay host's Let's Encrypt certificate**, renewed by DNS-01 ([infra/relay/README.md](../relay/README.md#certificates)), and the broker's, renewed the same way ([infra/broker/README.md](../broker/README.md)).

A CAA set that leaves out an authority in use does nothing until that certificate's next renewal, which then fails, and nothing reports the failure until the certificate expires. Before changing `caa_issuers` in `zone.tf`, read the issuer of the certificate each name serves (`openssl s_client -connect <name>:443 -servername <name>`), and after the change, run an issuance for the relay's names against Let's Encrypt's staging directory, so a refused DNS-01 path shows before the next real renewal.

Observed on 2026-10-26: once the zone held a CAA record, the apex also answered CAA lines Cloudflare adds itself -- `issue` for `comodoca.com`, `digicert.com` and `ssl.com`, and `issuewild` lines for those and the two declared authorities -- and the declared `pki.goog` was answered as `pki.goog; cansignhttpexchanges=yes`. A plan after the apply showed no change, so the provider does not read these as drift.

## DNSSEC

DNSSEC is on, Cloudflare signing the zone, with the DS record at the `.org` registry pointing at Cloudflare's key-signing key. The order matters in both directions, because a DS record at the registry with no signed zone behind it makes every name in the zone fail validation:

- **Turning it on:** the zone is signed first (`status = "active"`), then the DS record that Cloudflare shows (`ds` on the resource) is added at the registrar.
- **Turning it off:** the DS record is removed at the registrar first, then DNSSEC is turned off in the zone only after the registry's DS TTL has passed since the removal (`dig DS <zone>` shows the TTL). `prevent_destroy` on `cloudflare_zone_dnssec.zone` refuses a plan that destroys or replaces the resource, but not one that sets `status` to `disabled`, which is an in-place update: read the plan before an apply that touches it.

Check it from a validating resolver: `dig @1.1.1.1 <zone> A +dnssec` answers with the `ad` flag.

## What the live account and zone do

Planning and applying this root against the live account and zone settles these of its assumptions:

- **Confirmed:** OpenTofu 1.10 or later (1.12.6), and the S3 backend with `use_lockfile`.
- **Confirmed:** the Cloudflare provider's v5 schema. In 5.25.0, `cloudflare_zone_setting` takes `setting_id` and `value`, and `cloudflare_dns_record` requires `ttl`. The HSTS `security_header` value as a `strict_transport_security` object imports with no difference, and the zone-setting import id is `<zone-id>/<setting_id>`.
- **Confirmed:** the zone settings. SSL/TLS mode `strict`, Always Use HTTPS on, and HSTS with no `includeSubDomains`, no preload and `nosniff` `false` all import with no difference.
- **Confirmed:** each public name is a proxied `CNAME` with automatic TTL, the production name to the project's `pages.dev` name and the staging name to `staging.<project>.pages.dev`, and the staging name is a custom domain on the `staging` branch alias; whether it serves the newest `staging` deployment or tracks production is checked on the next staging deploy that changes a web file.
- **Confirmed:** the Read-only token, with Cloudflare Pages Read added, plans the root with no change, measured before the project site's resources were added.
- **Confirmed:** the project site's first apply (2026-10-12). The plan was `cloudflare_pages_project.site`, `cloudflare_dns_record.site_name` and `cloudflare_pages_domain.site` to add, with 0 to change and 0 to destroy; the apply added the three, and a re-plan with `-detailed-exitcode` exited `0`. No record answered at the apex before the apply, and the apex record was accepted.
- **Not yet observed:** the site's name was still `initializing`, with validation `pending`, right after the apply. Whether it reaches `active` as a custom domain of the site project has not been observed.
- **Confirmed:** before the zone's records were added (2026-10-26, asking the zone's authoritative server): no record at `www`, and no `MX`, `TXT` or `CAA` record at the apex, at `_dmarc`, or at any name in the zone.
- **Confirmed:** DNSSEC was already on (2026-10-26). The registry's DS record (key tag 2371, algorithm 13, digest type 2) names the zone's key-signing key, and `1.1.1.1` and `8.8.8.8` both answer the apex with the `ad` flag.
- **Confirmed:** the issuer of each name's certificate (2026-10-26). Google Trust Services issues for the apex, `psi.`, `staging.`, `demo.` and `www`; Let's Encrypt issues for `signal.`, `turn.`, `registrar.` and `relay.`. Pages' `certificate_authority` is `google` on all four Pages domains. Every issuer is within `caa_issuers`.
- **Confirmed:** the dashboard's permission names (2026-10-26). Zone -> Single Redirect -> Read on the plan token and Edit on the apply token. DNSSEC needs nothing beyond DNS: the DNSSEC import ran under DNS Read.
- **Confirmed:** DNSSEC imports with one difference (2026-10-26): three attributes, `dnssec_multi_signer`, `dnssec_presigned` and `dnssec_use_nsec3`, which the provider reads as unset. `zone.tf` does not declare them, and a plan after the apply showed no change.
- **Confirmed:** the zone accepted the `MX` and `TXT` records beside the proxied names (2026-10-26).
- **Confirmed:** plain HTTP to `www` is redirected to `https://data-bridge.org` in one step, not through `https://www` (2026-10-26).
