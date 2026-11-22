# Software & Version Manager

## Implemented catalog

The Software & Versions area is available to Owner/Admin accounts at **Admin → Software & Versions**. Catalog entries, version records, synchronization jobs and software operations are stored in MongoDB. Catalog changes and important operations are written to the existing audit log.

On API startup, NIMBUS inserts safe default catalog presets using `$setOnInsert`. Existing catalog records are never overwritten by this seeding step. Presets are enabled for Admin review but are not customer-visible, do not auto-sync and do not auto-publish until an Admin explicitly changes those settings.

Implemented source adapters:

- **GitHub Releases** — configured public `owner/repository`, paginated.
- **Minecraft Vanilla** — Mojang's official version manifest.
- **PaperMC / Folia** — official PaperMC project API.
- **Purpur** — official Purpur API.
- **Fabric** — official Fabric Meta API.
- **Quilt** — official Quilt Meta API.
- **Forge / NeoForge** — official Maven metadata.
- **Node.js** — official Node.js distribution index.
- **Python** — official Python release metadata.
- **PHP** — official PHP release metadata and source checksums; optional release line such as `8` or `8.4`.
- **Go** — official Go download index, including archive checksums and platform metadata.
- **.NET** — Microsoft release metadata for a configured channel such as `8.0`.
- **Eclipse Temurin Java** — official Adoptium release metadata.
- **MongoDB Server** — official MongoDB release manifest, filtered to stable releases and supported Ubuntu targets.
- **Lavalink** — official Lavalink project releases.
- **Modrinth** — versions from a configured Modrinth project ID.
- **Docker Hub** — tags from a configured public namespace/repository; floating `latest` is skipped.
- **Manual** — fallback for software without an implemented source adapter.

The source adapters validate response shapes and use request timeouts. Paginated sources use bounded page limits. A source failure leaves existing catalog data intact and records a failed sync.

## Add and configure software

1. Open **Admin → Software & Versions → Add Software**.
2. Enter a unique lowercase identifier, name, description and official website.
3. Enter service type values exactly as used by NIMBUS, for example `minecraft`, `discord`, `website`, `backend`, `nodejs`, `python`, `mongodb`, `database`, `docker`, `lavalink`, or `custom`.
4. Choose the official source adapter and fill any required repository, project or release-channel fields.
5. Configure a trusted Docker image-template adapter only if its version-tag convention is verified. Use `{version}` in the image tag or, for a compatible application, in an environment value with a supported version probe.
6. Configure supported OSes, architectures and runtime metadata where relevant.
7. Choose auto-sync frequency and whether eligible stable releases may be automatically published.
8. Keep **Customer availability** disabled until the software and installer have been reviewed.

The Admin form also accepts KVM/libvirt OS-image metadata. This is catalog metadata only; no VM reinstall action is available until a real virtualization provider and Node Agent are implemented and verified.

## Fetch, import and publish versions

- **Fetch Versions** calls the selected official source and stages a preview.
- Preview results show newly discovered, already imported and incompatible versions.
- Admins can select versions or import all eligible discoveries in one operation.
- Duplicate software/version pairs are protected by a unique database index and are not re-created.
- New versions are pending approval by default. Auto-publishing is an explicit per-software setting and excludes prereleases and incompatible/incomplete records.
- Admins can manually add a version as a fallback, edit metadata, publish/disable/deprecate versions, set a recommended version and use bulk actions.
- Version lists are paginated (50 per page in the Admin UI; API limits are capped at 100).
- Preview data expires after 24 hours. Failed imports are counted and are not reported as successful.

## Automatic synchronization

Each software entry can use manual-only, 6-hour, 12-hour, 24-hour or 7-day synchronization. The API scheduler checks due entries every 15 seconds and enqueues jobs in the persistent MongoDB `software_sync_jobs` collection. Jobs have unique time-bucket keys, bounded retries, retry delays, worker leases and a retry action in the Admin UI. Job state survives an API restart; the scheduler/worker itself currently runs inside the API process rather than a separate worker service.

## Initial service provisioning from the catalog

The Admin **Assign Service** wizard now selects an enabled catalog entry and a published compatible version for the chosen service type. It no longer asks the Admin to type an arbitrary Docker image for catalog-managed services. The backend resolves the image tag and version-bearing environment from the catalog, checks the service type and version publication state, and keeps VPS/VDS requests out of the Docker path.

The Node Agent verifies the initial container image, running state, configured environment and Docker health check when present. When the catalog configures a supported application version probe, the agent runs that fixed probe before returning success. If the probe does not confirm the requested version, the newly created container is removed and the service is left in an error state rather than being recorded as successfully installed. Only Owner/Admin accounts can use the initial catalog provisioning endpoint.

## Customer software changes

The existing service page includes a **Software** tab. The API filters catalog options by the service's exact type and checks service ownership. Customers cannot access Admin catalog endpoints, import/publish versions or change another customer's service. VPS/VDS software changes are rejected by the backend as well as hidden from the customer selector.

A version is selectable only when the software is enabled and customer-visible, the version is published, not deprecated, compatible, and the catalog entry has a configured Docker image-template adapter. Catalog-only entries remain visible to Admins but cannot be installed by customers.

For supported container upgrades, NIMBUS:

1. Checks ownership, service type, catalog state, version publication and compatibility.
2. Creates a pre-update backup through the existing backup service.
3. Pulls the target image before touching the existing container.
4. Retains the previous container and reuses the existing service data directory.
5. Starts the new container with the service's resource limits and preserved environment; explicit catalog overrides replace only matching keys.
6. Verifies the new container is running with the requested image, configured environment and a healthy Docker health check when one exists.
7. Runs an approved fixed application-version probe when configured (Minecraft startup log, Node.js, Python, PHP, Go, Java, .NET or MongoDB).
8. Updates the service/version record only after verification, then performs previous-container cleanup as a separate commit step.
9. Retains the previous container and records a warning if final cleanup fails. If saving the new service state fails, the agent attempts to restore the previous container.

Operations are recorded with status, progress, backup reference, errors and verification details. The customer Software tab displays operation history. The adapter does not provide a universal HTTP/application health check for every software family; where no Docker health check or supported version probe exists, the UI and operation record must not claim that application-level health was verified.

## Node credential compatibility

Control-plane-to-agent requests use the per-node enrollment credential encrypted at rest by the API. Nodes enrolled before this field was added need credential re-enrollment before agent-backed operations work. Use **Admin → Nodes → Revoke Credentials**, then run the newly generated installer command on that node. The re-enrollment installer preserves service data and the TLS certificate.

Never share enrollment tokens or node credentials in support tickets or public channels.

## Explicit limitations

- The verified installation adapter currently performs Docker image-template operations only. Dedicated native installers for every runtime and framework are not complete.
- Catalog discovery is broader than installation support: a source adapter does not automatically make a software package installable. Admins must verify the official image/tag convention and configure the installer before enabling customer access.
- VPS/VDS OS catalog metadata is Admin-managed, but the repository does not yet contain a KVM/libvirt virtualization Node Agent/provider. No OS reinstall or replacement is claimed to work. The Docker provisioning endpoint explicitly rejects VPS/VDS requests.
- The sync queue is persisted in MongoDB, but its scheduler/worker runs in the API process; it is not a separate queue service.
- Application-specific health checks are not available for every image. Runtime version probes are limited to the fixed commands supported by the Node Agent.
- Per-service SFTP account provisioning is not part of this Software & Version Manager implementation.

Do not use the existing destructive **Reinstall** action to change software. Software upgrades must use the Software tab's backup-and-upgrade workflow.
