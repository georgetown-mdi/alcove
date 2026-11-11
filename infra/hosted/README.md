# The project's hosted environment

This root describes the project's own hosted deployment of the web application -- the Cloudflare Pages project that serves it, the project's two custom domains, the DNS records for them and the Cloudflare zone settings in front of both -- so the edge settings are code a reviewer reads, and a drift is a plan that is not empty. Beside it, the project site's Pages project, served at the zone apex ([The project site](#the-project-site)), and the demo site's, a second deployment of the web application with a name of its own ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-demo-site)). The zone's own records sit beside them: the `www` redirect, the records stating that no name in the zone sends or receives mail, the CAA records, and DNSSEC. It is about the project's own deployments alone; an agency hosting the web application itself starts from [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the Cloudflare account and zone and for the AWS account that holds the state.

This document also holds the maintainer's runbook for the deployments themselves: the workflows that upload each site, the GitHub environments, secrets and variables they read ([Deploying to Cloudflare Pages](#deploying-to-cloudflare-pages)), the zone settings ([Custom domains and zone settings](#custom-domains-and-zone-settings)), the demo site's upload ([The demo site's upload](#the-demo-sites-upload)), and the project site ([The project site](#the-project-site)). What the hosted deployment is, which services run where, and the headers it serves are in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-projects-hosted-web-deployment).

## What it describes

| File            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.tf` | The Pages project (`cloudflare_pages_project.hosted`, direct upload, production branch `main`) and both public names as its custom domains (`cloudflare_pages_domain.production` and `.staging`). A proxied DNS record for each public name: the production record points at the project's `pages.dev` name, and the staging record at the `staging` branch alias, `staging.<project>.pages.dev`. Three zone settings: SSL/TLS mode `Full (strict)` (`ssl = strict`), Always Use HTTPS, and HSTS at `max-age=15552000` without `includeSubDomains` or preload -- the values [Custom domains and zone settings](#custom-domains-and-zone-settings) records. The project site's Pages project (`cloudflare_pages_project.site`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.site`), and a proxied record for that name (`cloudflare_dns_record.site_name`) pointing at the site project's `pages.dev` name. The demo site's Pages project (`cloudflare_pages_project.demo`, direct upload, production branch `main`), its name as the project's custom domain (`cloudflare_pages_domain.demo`), and a proxied record for that name (`cloudflare_dns_record.demo_name`) pointing at the demo project's `pages.dev` name |
| `zone.tf`       | The zone's records outside any one site. A proxied record for `www` (`cloudflare_dns_record.www`, `AAAA` to the discard address `100::`) and the zone's entry point for the redirect phase (`cloudflare_ruleset.redirects`), whose one rule answers every request on `www` with a `301` to the same path and query on the site's name. On every name that answers with an address -- the apex, `www`, the two public names, the demo site's name and the DNS-only names -- a null MX (`cloudflare_dns_record.null_mx`, RFC 7505) and SPF `v=spf1 -all` (`cloudflare_dns_record.spf`); DMARC `v=DMARC1; p=reject` at `_dmarc` (`cloudflare_dns_record.dmarc`), with no report address. CAA `issue` records at the apex for each certificate authority that issues for a name in the zone (`cloudflare_dns_record.caa`, see [Certificate authorities](#certificate-authorities)). Once the challenge-only domain is set, on each DNS-only name a `CNAME` from `_acme-challenge` into its zone (`cloudflare_dns_record.acme_challenge`, see [Delegated ACME challenges](#delegated-acme-challenges)). DNSSEC (`cloudflare_zone_dnssec.zone`) |
| `variables.tf`  | Every account-specific value -- the zone id, the Cloudflare account id, the three Pages project names, the two public names, the site's name, the demo site's name, and the DNS-only names (the relay host's, whose address records this root does not declare) -- with no default, and the challenge-only domain, empty by default ([Delegated ACME challenges](#delegated-acme-challenges))                                                                                                                                                                                                                                                                                                         |
| `providers.tf`  | The Cloudflare provider, which reads its token from the environment |

The records that serve a name, the Pages projects and DNSSEC have `prevent_destroy`, so a plan that would replace one fails instead of proposing it. The mail and CAA records do not: removing a name or a certificate authority from the list one comes from removes its record. The Pages projects' deployments are outside this root: [`pages_deploy.yaml`](../../.github/workflows/pages_deploy.yaml) uploads the web application's and the demo site's production deployments from a push to `main` and their `staging` previews from a push to `staging`, [`release.yaml`](../../.github/workflows/release.yaml) redeploys production from a release tag, [`site_publish.yaml`](../../.github/workflows/site_publish.yaml), run by hand, uploads the project site's production deployment, and [`site_deploy.yaml`](../../.github/workflows/site_deploy.yaml) its `staging` preview from a push to `staging`.

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the Cloudflare account id and the zone id included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: `CLOUDFLARE_API_TOKEN`, and the S3 state backend's AWS credentials, which the backend reads itself from its default chain (`AWS_PROFILE`, or the `AWS_*` variables). The AWS principal reads and writes the state object in the bucket and nothing else. With no AWS provider in this root, nothing checks which AWS account the credentials belong to; the backend's bucket name binds the state to the account that owns it. Two Cloudflare tokens keep reads apart from changes, and neither one's permissions are edited between runs:
  - The plan token, for import, plan and drift checks, holds Zone -> Zone Settings -> Read, Zone -> DNS -> Read and Zone -> Single Redirect -> Read on the one zone, and Account -> Cloudflare Pages -> Read on the account.
  - The apply token, used only for an apply whose plan changes a Cloudflare resource, holds the same scope with Edit: Zone -> Zone Settings -> Edit, Zone -> DNS -> Edit and Zone -> Single Redirect -> Edit on the one zone, and Account -> Cloudflare Pages -> Edit on the account.
  - Single Redirect is for `cloudflare_ruleset.redirects`; DNSSEC needs nothing beyond DNS ([measured](#what-the-live-account-and-zone-do) on 2026-10-26: the DNSSEC import ran under DNS Read). A plan of the ruleset sends its rules to the API as a dry run (`POST .../rulesets?dry_run=true`, measured against a stand-in API on 2026-10-26); a refused dry run is a plan warning, not an error.

  Creating a record needed DNS Edit, and creating a Pages project and adding its domain needed Cloudflare Pages Edit, both measured on the first site apply (2026-10-12); changing a zone setting needs Zone Settings Edit. A token's policy shows only in the Cloudflare dashboard: a read through the token succeeds whatever Edit it lacks, and an apply missing one fails with `403` partway, after creating what it could (2026-10-22). Without Zone Settings Read, the zone-setting imports fail with `403`. The permission list `GET /zones` returns is the account member's, not the token's, so it does not show what the token holds.

The relay host's certificate renewal token is not one of this root's, and neither token above goes to that host:

- **Provider:** Cloudflare, an account-owned API token, so it outlives any one member's access.
- **Permissions:** Zone -> DNS -> Edit and Zone -> Zone -> Read, on the challenge-only zone alone ([Delegated ACME challenges](#delegated-acme-challenges)). It can change no record that serves a name.
- **IP filter:** the relay host's address only.
- **Expiry:** none, since the renewal runs unattended; the IP filter and the zone scope bound what a leaked copy can do.
- **Storage:** `CLOUDFLARE_DNS_API_TOKEN` in the host's `/etc/alcove-relay/acme.env`, mode 600, written over SSM and in no file in the repository or the instance's user-data ([infra/relay/README.md](../relay/README.md#certificates)).

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

The demo site's project, domain and record are created by an apply the same way, and the same request with `name` set to the demo site's name lists what would collide with its record. After that apply, check in the Cloudflare dashboard that Web Analytics is off for the demo project, as [PRIVACY.md](../../PRIVACY.md#hosted-web-application) records for the web application's project. Set the deploy variable `CLOUDFLARE_DEMO_PAGES_PROJECT` to the demo project's name only after both: the deploy workflow skips the demo upload while it is unset ([The demo site's upload](#the-demo-sites-upload)).

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

## Delegated ACME challenges

The relay host renews its Let's Encrypt certificates by DNS-01, and a token that can write the challenge in this zone could also repoint every name in it, the public names included: Cloudflare scopes a DNS grant to a zone, not a record. So each DNS-only name delegates its challenge to a zone on a second domain, registered for this alone, whose token the relay host holds ([infra/relay/README.md](../relay/README.md#certificates)):

- **The records:** `_acme-challenge.<name>` is a `CNAME` to `_acme-challenge.<acme_challenge_domain>` for every name in `dns_only_names`, each a name on a certificate the relay host renews: the TURN relay's, the registrar's, the WebSocket relay's and the broker's. With `acme_challenge_domain` empty, the default, the root declares none of them.
- **Register the domain and add its zone before setting `acme_challenge_domain`.** A record pointing at a domain nobody has registered lets whoever registers it obtain a certificate for every delegated name. Keep its registration renewing for the same reason.
- **Collisions:** a `CNAME` shares its name with no other record, so before the apply list what the zone holds at each `_acme-challenge.<name>` (the `dns_records` request in [Adopting the live resources](#adopting-the-live-resources), `name` set to it). A `TXT` an ACME run left behind there makes the apply fail; delete it.
- **The switch:** once the records exist, a renewal writes the challenge in the challenge zone, which the token in the host's `acme.env` must reach. Apply them in the same sitting as that token is put on the host, then run the staging issuance [infra/relay/README.md](../relay/README.md#certificates) gives before revoking the host's earlier token.

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

## Other resources the AWS account keeps

The AWS account that holds the state has resources this root does not manage, created by hand or by AWS. The account owner owns each one below, and each is kept.

- **Budget `alcove-hosted-monthly`:** 33 USD a month, with no filters and no actions. It has three email notifications, for actual spend above 26 USD, actual spend above 30 USD and forecast spend above 33 USD, each sent to the account owner.
- **Service-linked roles:** AWS creates these for a service on first use, and they cost nothing while standing. `AWSServiceRoleForAutoScaling`, `AWSServiceRoleForElasticBeanstalk`, `AWSServiceRoleForOrganizations`, `AWSServiceRoleForResourceExplorer`, `AWSServiceRoleForSSO` and `AWSServiceRoleForSupport` are kept. None shows a recorded use. The SSO login depends on `AWSServiceRoleForSSO`, and `AWSServiceRoleForSupport` is an account default.

## Deploying to Cloudflare Pages

The web application builds only as a static site: `npm run build -w apps/web` writes `apps/web/dist/hosted/` and no server ([hosted-static-build.md](../../docs/notes/hosted-static-build.md)). Two workflows upload that directory to the Pages project by direct upload, each only when every suite in [`web_build_and_test.yaml`](../../.github/workflows/web_build_and_test.yaml) passes:

- **Production, from a push to `main`:** [`pages_deploy.yaml`](../../.github/workflows/pages_deploy.yaml) uploads on a push to `main` that changes a deploy-affecting source, and on a manual dispatch on `main`, so a change to the site goes out without a release. It uploads only once a signed manifest of the build exists ([RELEASES.md](../../docs/RELEASES.md#the-manifest-of-a-main-deploy)). The trigger, path filter and gate are described in the workflow file.
- **Production, from a release tag:** [`release.yaml`](../../.github/workflows/release.yaml) builds the site from the pushed `vX.Y.Z` tag and uploads it once the release images are published, so a tag the release refuses deploys nothing ([RELEASES.md](../../docs/RELEASES.md#8-build-and-publish-the-container-image-ci)). It redeploys production from the tag's commit only for a tag on the newest release line or a prerelease tag ([RELEASES.md](../../docs/RELEASES.md#prereleases)), so a hotfix on an older line deploys nothing ([RELEASES.md](../../docs/RELEASES.md#hotfix-releases)), and only while `main` holds no commit the tag's commit lacks, so a release run that ends after a newer push to `main` has deployed leaves that build in place ([RELEASES.md](../../docs/RELEASES.md#8-build-and-publish-the-container-image-ci)); the next push to `main` replaces it.
- **Staging preview:** `pages_deploy.yaml` uploads on a push to `staging` that changes a deploy-affecting source, and on a manual dispatch on `staging`.

What each build shows and how each upload runs:

- **Version shown:** a deployment from a release tag shows the product version of the tag in its footer, `Version X.Y.Z`, and its commands name that release's image. A build from a push to `main` or `staging` shows the short commit hash instead, `Commit 1a2b3c4`, and its commands name the `latest` image ([RELEASES.md](../../docs/RELEASES.md#versioning)).
- **Build and artifact:** the gate's packaging job builds the site with `VITE_SIGNALING_SERVER_URL` set from the variable of that name, and fails when it is unset. The same job builds [the demo site](../../docs/DEPLOYMENT.md#the-demo-site) as a second artifact. Off a pull request it installs from the lockfile and builds core itself rather than restoring either from the Actions cache, and it reports each artifact's id and a SHA-256 over its files.
- **Upload:** a job of its own in each workflow. It checks out only the deploy tool's `package.json` and lockfile (`.github/wrangler/`) and installs wrangler from them with `npm ci`, downloads each artifact by the id the build reported, stops if its files do not match the build's digest, and runs `wrangler pages deploy`. A deployment to the project's production branch, `main`, is the production deployment, whether it comes from a push to `main` or a release tag; one to `staging` is a preview, served on the project's `staging` branch alias (`staging.<project>.pages.dev`). The same job then uploads the demo site's artifact to the demo project. These two jobs and the project site's two upload jobs ([The project site](#the-project-site)) are the only jobs in any workflow that hold the deploy credentials, and none runs repository code other than the locked deploy tool.
- **Post-deploy check:** a later job, holding no credentials, fetches `/.well-known/security.txt` from each deployment the upload made, at the deployment's own `pages.dev` address, and fails the run unless the file is served as `text/plain` with the contacts `SECURITY.md` names (`scripts/check-served-security-txt.mjs`).
- **Environment rule:** under Settings -> Environments, give `Staging` a deployment branch rule allowing only `staging`, and give `Production` one allowing the `main` branch, for the project site and the hosted app, and tags matching `v*.*.*`, for the release upload.

It reads two secrets and six variables. The release upload and the upload from a push to `main` run in the GitHub environment `Production`, and the upload from a push to `staging` in `Staging`, so the two secrets and the two Pages project names are set on each of those environments. `VITE_SIGNALING_SERVER_URL` and the default relay variables are read by the gate's builds, which run in no environment, so they are repository variables, under Settings -> Secrets and variables -> Actions.

| Name | Kind | Set on | What it is |
| ---- | ---- | ------ | ---------- |
| `CLOUDFLARE_API_TOKEN` | Secret | Environments `Production` and `Staging` | An API token scoped to Account -> Cloudflare Pages -> Edit on the one account, and nothing else. The grant is account-wide, so `Staging`'s token can deploy production too, without a signed manifest: the environment rule keeps a staging job from `Production`'s token, not from production. After a token incident, rotate the token on both environments |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Environments `Production` and `Staging` | The Cloudflare account the project is in |
| `CLOUDFLARE_PAGES_PROJECT` | Variable | Environments `Production` and `Staging` | The Pages project's name |
| `CLOUDFLARE_DEMO_PAGES_PROJECT` | Variable | Environments `Production` and `Staging` | The demo site's Pages project's name; unset, the job skips the demo site's upload |
| `VITE_SIGNALING_SERVER_URL` | Variable | Repository | The peer-coordination broker's `wss:` address, built into the site and the demo site |
| `VITE_DEFAULT_RELAY_TURN_URL` | Variable | Repository | The project relay's TURN url, `turns:turn.data-bridge.org:443?transport=tcp`, built into the site and the demo site as [the default relay](../../docs/DEPLOYMENT.md#the-default-relay); unset, neither names one |
| `VITE_DEFAULT_RELAY_REGISTRAR_URL` | Variable | Repository | That relay's registrar, `https://registrar.data-bridge.org`; set with the variable above or not at all |
| `VITE_DEFAULT_RELAY_WEBSOCKET_URL` | Variable | Repository | That relay host's WebSocket relay, `wss://relay.data-bridge.org/relay`, built into the site and the demo site; set only beside the two above |

The site's build sets no `VITE_DEFAULT_RELAY_MODE`, so production and staging offer the project's relay switched off ([The default relay](../../docs/DEPLOYMENT.md#the-default-relay)). The demo site's build sets `VITE_DEFAULT_RELAY_MODE=on` in the workflow, not as a repository variable ([The demo site](../../docs/DEPLOYMENT.md#the-demo-site)).

## Custom domains and zone settings

Both public names are custom domains of the Pages project, each a proxied DNS record in the Cloudflare zone: the production name points at the project's `pages.dev` name, and the staging name at the `staging` branch alias. The demo site's name is a custom domain of the demo site's project in the same way, its record pointing at that project's `pages.dev` name. Public TLS terminates on a Cloudflare-managed edge certificate for the zone. The zone settings the root declares:

| Setting | Value |
| ------- | ----- |
| SSL/TLS mode | `Full (strict)` |
| Always Use HTTPS | On, so plain HTTP to any of these names is answered `301` at the edge |
| HSTS | On, `max-age=15552000`, without `includeSubDomains` and without preload |

The root also declares the zone's own records:

- **`www.data-bridge.org`** serves no site: the edge answers every request on it with a `301` to the same path and query on `https://data-bridge.org`, the project site.
- **No mail.** No name in the zone sends or receives mail. Each name that answers with an address has a null MX (RFC 7505) and SPF `v=spf1 -all`, and DMARC `p=reject` at `_dmarc.data-bridge.org` covers every name, with no report address.
- **CAA** records limit certificate issuance to the authorities that issue for the zone's names: Cloudflare's edge and Pages certificates, and Let's Encrypt for the relay host ([Certificate authorities](#certificate-authorities)).
- **DNSSEC** is on, with the DS record at the registry ([DNSSEC](#dnssec)).
- **`/.well-known/security.txt`** (RFC 9116) is served by the web application's build, on the two public names and the demo site's, and by the project site's build at the apex. It names the reporting routes [SECURITY.md](../../SECURITY.md#reporting-a-vulnerability) names, and its `Expires` date is renewed by hand: `scripts/security-txt.test.mjs` fails 45 days before it. Each deploy checks the file it served ([Deploying to Cloudflare Pages](#deploying-to-cloudflare-pages)).

## The demo site's upload

[The demo site](../../docs/DEPLOYMENT.md#the-demo-site) is uploaded by the same workflows as the site:

- **When it deploys:** the deploy gate's packaging job builds it beside the site, and the upload job uploads it after the site's own upload. A push to `main` is the demo project's production deployment, served at `demo.data-bridge.org`, and a release tag on the newest release line, or a prerelease tag, redeploys it from the tag's commit until the next push to `main`; a push to `staging` is a preview on the demo project's `staging` branch alias, `staging.<demo project>.pages.dev`, which no custom domain names.
- **What a failed upload does:** the site's own upload has already finished, so the site stays deployed and the run fails.
- **Turning the upload on:** the upload job skips the demo site's steps while its environment sets no `CLOUDFLARE_DEMO_PAGES_PROJECT`. Set it on both environments only after the demo project exists ([Adopting the live resources](#adopting-the-live-resources)).

## The project site

The project site, at `data-bridge.org`, publishes the Markdown under `docs/` and `site/` and the repository's top-level changelog, contributing guide, license, privacy statement, security policy, and support page. The design notes under `docs/notes/` are not published: a link to one points at the file on GitHub. [VitePress](https://vitepress.dev/) builds it, configured by `site/.vitepress/config.mjs`, and a Cloudflare Pages project of its own serves it, declared in this root.

- **Two sections:**
  - **Project pages and guides:** the project pages under `site/` (home, who it is for, about, and contact) and the step-by-step guides under `site/guides/` are served at the site root: the home page at `/`, the guides' home page at `/guides`, and every other page at `/<file name without .md>`. They share a layout of their own (`site/.vitepress/theme/GuideLayout.mjs`) whose menus list these pages and, under About, one link to the documentation. The project pages state no versions, channel or command names, or feature comparison: those stay in the guides and the reference documentation, which the pages link to.
  - **Reference documentation:** every other page, served at its repository path in VitePress's default theme, with its own navigation and links back to the home page and the guides. The overview, `docs/index.md`, is at `/docs/overview`.
- **Fonts:** the guides' fonts are npm packages (`@fontsource-variable/*`) bundled into the site.
- **Building it:** `npm run site:build` writes `site/.vitepress/dist/`, and `npm run site:dev` serves the site locally. A relative link to a page the site publishes becomes that page's address, and one to any other file in the repository points at the file on GitHub. The build fails on a relative link to a Markdown page that does not exist; `npm run linkcheck` checks every other relative link and each `#anchor`.
- **Staging preview:** [`site_deploy.yaml`](../../.github/workflows/site_deploy.yaml) builds the site on a pull request into `main` or `staging` and on a push to `staging` that changes a source the build reads. It uploads the build of the push, or of a manual dispatch on `staging`, as a preview on the site project's `staging` branch alias. A push to `main` builds and uploads nothing.
- **Pull requests that change only the project pages:** a pull request that changes only the Markdown pages directly under `site/` or their images under `site/img/` skips the PR checklist check ([`pr_checklist.yaml`](../../.github/workflows/pr_checklist.yaml)). A change to the guides or to `site/.vitepress/` runs it.
- **Production, published by hand:** the "Publish site" workflow, [`site_publish.yaml`](../../.github/workflows/site_publish.yaml), builds the site from a ref chosen when it is run, `main` unless another is named, and uploads it as the production deployment. It then moves the `site-published` tag to the commit it built. It fails unless dispatched from `main`, and unless the chosen commit is on `main` or `staging`. When to run it, and the review of the changes since the last publish: [RELEASES.md](../../docs/RELEASES.md#11-publish-the-project-site).
- **Build:** the push, dispatch and publish builds install from the lockfile rather than restoring from the Actions cache.
- **Upload:** a job of its own in each workflow. Like the web application's, it installs wrangler from the locked deploy tool with `npm ci` and runs `wrangler pages deploy`; unlike it, the job downloads the build's artifact by name and does not check it against a digest. It has the same post-deploy check, and uses the same environments and secrets: the preview runs in `Staging` and the publish in `Production`. It also reads `CLOUDFLARE_SITE_PAGES_PROJECT`, the site project's name, a variable set on both environments.
- **The tag:** the publish moves `site-published` in a later job, the only job in either workflow with write access to the repository. That job holds no deploy credential and runs no repository code: it sets the tag through the GitHub API.
- **Headers:** the build writes no `_headers` file, so Pages serves the site with its default headers and the [zone settings](#custom-domains-and-zone-settings).
- **Redirects:** the build's `_redirects` file (`site/.vitepress/public/_redirects`) sends `/instructions` to `/guides` and `/instructions/<page>` to `/<page>`, and the design notes' former addresses, `/docs/notes` and `/docs/notes/<name>`, to the same files on GitHub.
