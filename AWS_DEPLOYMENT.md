# AWS Deployment

The frontend is static, but the customer/admin portals also require a separately deployed backend:

1. `S3` bucket for site files
2. `CloudFront` distribution in front of the bucket
3. `ACM` certificate for HTTPS
4. `Route 53` only if you want AWS to manage DNS
5. `EC2` running the Node.js API behind nginx

## Current Production Targets

- Website: `https://stickman-handyman.com`
- Frontend bucket: `stickmanhandyman-site-prod`
- CloudFront distribution: `EPPZMKY13FHTA`
- API: `https://api.stickman-handyman.com`
- API instance: `i-0740d2d07de9def1d` in `us-east-1` (verify before a release; instances can be replaced)
- Application directory: `/opt/stickman-handyman-website`
- Backend service: `stickman-handyman.service`, running as `ubuntu` from the application's `backend/` directory

Frontend and backend releases are separate. Publish related API and frontend changes together when their behavior depends on matching versions.

## Recommended setup

Use a private S3 bucket with CloudFront Origin Access Control.

Why this structure:

1. Lowest practical monthly cost for a real static business site
2. HTTPS on your custom domain
3. Better caching and performance than direct S3 website hosting
4. The API and private runtime data remain separate from public website assets

## Files to deploy

The authoritative frontend allowlist is in `deploy-to-s3.ps1`. It includes:

1. `home.html`
2. `gallery.html`
3. `contact.html`
4. `portal.html`, `admin.html`, and `portal-*.html`
5. `portal-shared.js`
6. `maintenance-packages.html`
7. `nav.html` and `footer.html`
8. `styles.css` and `load-components.js`
9. `projects.json`
10. `css/`, `js/` (including `js/admin/`), `images/`, `invoice_template/`, and `fonts/`

Do not deploy these folders and files:

1. `projects_input/` - raw source photos used to generate gallery assets
2. `.git/` - repository metadata
3. `.vscode/` - editor settings
4. `add_project.ps1` - local content generation helper
5. `PROJECT_SETUP.md` - internal workflow notes
6. `README.md` - repository documentation only
7. `backend/` - released separately to EC2, never uploaded to the frontend bucket
8. `.env` files, SSH private keys, and generated PDFs in `Invoices/`

## AWS setup steps

### 1. Create the S3 bucket

1. Create one bucket for the site content.
2. Keep `Block all public access` enabled.
3. Do not enable static website hosting on the bucket.

Suggested naming:

1. `stickmanhandyman-site`
2. `www.yourdomain.com`

### 2. Request an ACM certificate

1. In AWS Certificate Manager, request a public certificate in `us-east-1`.
2. Add your domain names, usually:
   - `yourdomain.com`
   - `www.yourdomain.com`
3. Validate using DNS records.

CloudFront requires the certificate in `us-east-1`.

### 3. Create the CloudFront distribution

1. Set the S3 bucket as the origin.
2. Use `Origin Access Control`.
3. Set `Default root object` to `home.html`.
4. Redirect HTTP to HTTPS.
5. Attach the ACM certificate.
6. Add your custom domain names as alternate domain names.

Recommended custom error responses:

1. `403` -> `/home.html` with response code `200`
2. `404` -> `/home.html` with response code `200`

That is optional here, but useful if you later move to cleaner URLs.

### 4. Grant CloudFront access to the bucket

When you create Origin Access Control, AWS can generate the bucket policy for you.

### 5. Point your domain to CloudFront

If you use Route 53:

1. Create an alias `A` record for `yourdomain.com` to the CloudFront distribution.
2. Create an alias `A` record for `www.yourdomain.com` to the same distribution.

If your DNS stays outside AWS:

1. Point `www` to the CloudFront distribution domain using `CNAME`.
2. For the apex domain, use your DNS provider's `ALIAS`, `ANAME`, or equivalent flattening record if supported.

## Frontend Deployment

Use the provided PowerShell script:

```powershell
.\deploy-to-s3.ps1 -BucketName "your-bucket-name" -DistributionId "YOUR_DISTRIBUTION_ID"
```

For the current production target:

```powershell
.\deploy-to-s3.ps1 -BucketName "stickmanhandyman-site-prod" -DistributionId "EPPZMKY13FHTA"
```

This syncs all allowlisted frontend files, including other local edits, and uses `--delete` for matching remote paths. Review the dry run first. It creates a CloudFront invalidation but does not wait for completion; wait for it to complete and verify the live pages before declaring a release finished.

One-command publish flow (generate projects, then deploy):

```powershell
.\deploy-to-s3.ps1 -BucketName "your-bucket-name" -DistributionId "YOUR_DISTRIBUTION_ID" -BuildProjects
```

Dry run first if you want to verify the file list:

```powershell
.\deploy-to-s3.ps1 -BucketName "your-bucket-name" -DryRun
```

Dry run with project generation:

```powershell
.\deploy-to-s3.ps1 -BucketName "your-bucket-name" -BuildProjects -DryRun
```

## Backend Release Checklist

Use `backend/deploy/deploy-backend.ps1` with `backend/deploy/release.sh`. The PowerShell wrapper defaults to a dry run:

```powershell
.\backend\deploy\deploy-backend.ps1 -HostName "api.stickman-handyman.com" -KeyPath "C:\path\to\your-private-key.pem"
```

Add `-Apply` only for an authorized release. It runs local `npm run verify`, stages allowlisted backend code/templates/fonts, installs locked production dependencies on the host, backs up runtime data, replaces application files, restarts the service, and verifies local and public health. Backend releases do not publish the frontend.

The host must already be provisioned, with the application's `backend/data/`, `backend/.env`, nginx/TLS configuration, service unit, Node.js, npm, curl, and tar. SSH host identity must already be trusted. The service user must have noninteractive permission for the required stop/restart operations; the script does not request elevation or change IAM/firewall rules. Encrypted SSH identities must be unlocked through an existing SSH agent; no passphrase is collected by the script.

Backups remain in the application's `.releases/` directory. The API is stopped briefly for a consistent runtime-data snapshot and code switch. A restart or local-health failure triggers automatic application-code/dependency rollback, not runtime-data rollback. A later public-health failure is reported for investigation; it does not automatically roll back a locally healthy backend. Backup retention/pruning is manual. Treat `.releases/` as private business data.

The repository also provides host configuration in `backend/deploy/api.nginx.conf` and `backend/deploy/stickman-handyman.service`. The nginx file is an HTTP reverse-proxy example, not a complete production TLS configuration.

1. Verify the production host and authorized SSH access. Keep private keys outside the repository and restrict their local file permissions; never paste credentials into commands or documentation.
2. Run `npm run verify` from the root or `backend/`, plus browser checks for changed workflows. Syntax checks alone do not verify invoice or payroll calculations.
3. Back up changed application files and production runtime state: `backend/data/` and the application's `invoices/` directory. Preserve `backend/.env` and the existing TLS/nginx configuration.
4. Stage only the intended source changes. Never replace production records with local JSON data, overwrite `.env`, or copy local `node_modules`. For dependency changes, use the reviewed lockfile and `npm ci --omit=dev` on the host.
5. Validate staged modules with `node --check` before replacing live files. Retain file permissions and keep a rollback copy outside `backend/src/`.
6. Restart `stickman-handyman.service` through the host's authorized service-management procedure. In-memory login sessions will be lost, so users may need to sign in again.
7. Confirm systemd reports the service active, then verify `http://127.0.0.1:3000/health` on the host and `https://api.stickman-handyman.com/health` publicly. Allow for startup time; the process becoming active does not guarantee it is listening yet.
8. If startup or health checks fail, restore the previous application files and restart the service. Do not roll back runtime data blindly, because new customer activity may have occurred.
9. Publish matching frontend changes, wait for cache invalidation, and verify the affected user workflow. Health checks confirm availability, not billing correctness.

## Cost Expectations

For the static frontend:

1. S3 storage is effectively negligible
2. CloudFront bandwidth is the main cost driver
3. Route 53 adds about `$0.50` per hosted zone each month if you use it

These frontend costs do not include EC2 compute, EBS storage, API traffic, backups, or payment-processing fees. Check the AWS billing console for actual production costs.