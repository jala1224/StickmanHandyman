# Cheapest AWS Structure

This site is fully static. The cheapest AWS structure that still gives you a proper custom-domain setup is:

1. `S3` bucket for site files
2. `CloudFront` distribution in front of the bucket
3. `ACM` certificate for HTTPS
4. `Route 53` only if you want AWS to manage DNS

## Recommended setup

Use a private S3 bucket with CloudFront Origin Access Control.

Why this structure:

1. Lowest practical monthly cost for a real static business site
2. HTTPS on your custom domain
3. Better caching and performance than direct S3 website hosting
4. No backend services needed for the current site

## Files to deploy

Deploy these files and folders:

1. `home.html`
2. `gallery.html`
3. `contact.html`
4. `nav.html`
5. `footer.html`
6. `styles.css`
7. `load-components.js`
8. `projects.json`
9. `images/`

Do not deploy these folders and files:

1. `projects_input/` - raw source photos used to generate gallery assets
2. `.git/` - repository metadata
3. `.vscode/` - editor settings
4. `add_project.ps1` - local content generation helper
5. `PROJECT_SETUP.md` - internal workflow notes
6. `README.md` - repository documentation only

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

## Deploy command

Use the provided PowerShell script:

```powershell
.\deploy-to-s3.ps1 -BucketName "your-bucket-name" -DistributionId "YOUR_DISTRIBUTION_ID"
```

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

## Cost expectations

For the current site:

1. S3 storage is effectively negligible
2. CloudFront bandwidth is the main cost driver
3. Route 53 adds about `$0.50` per hosted zone each month if you use it

In practice, this setup is often around `$1` to `$5` per month for a small static business site with low to moderate traffic.