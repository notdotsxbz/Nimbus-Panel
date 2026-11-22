# Software & Version Manager

## Current scope

The Software & Versions area is available to Owner/Admin accounts at **Admin → Software & Versions**. It stores software catalog entries and version records in the existing MongoDB database, and writes catalog actions to the existing audit log.

The currently implemented official-source adapters are:

- **GitHub Releases** — release metadata from a configured public `owner/repository`.
- **Node.js releases** — the official Node.js distribution index.
- **Go releases** — the official `go.dev` distribution index, including Linux archive checksums and architecture metadata.
- **MongoDB current releases** — MongoDB's official `current.json` feed, limited to Community (`targeted`) Linux packages, with per-platform URLs and SHA-256 metadata. This feed reports current releases per series, not every historical patch.
- **PaperMC builds** — the official PaperMC Fill v3 API for a configured Minecraft version, including stable/experimental channel and download metadata.
- **Purpur builds** — the official Purpur API for a configured Minecraft version, including build identifiers and direct release URLs.
- **Minecraft versions** — Mojang's official version manifest, including release/snapshot classification and manifest metadata.
- **Fabric-compatible game versions** — Fabric's official metadata API, including stable-version status.
- **Modrinth** — versions from a configured Modrinth project ID.
- **Docker Hub tags** — tags from a configured public Docker Hub namespace/repository.
- **Manual** — fallback for software without an implemented source adapter.

GitHub discovery follows up to 20 pages of 100 releases (up to 2,000 releases); if a source still has more data at that safety limit, discovery fails explicitly instead of silently returning a partial catalog. Node.js uses the official distribution index. Modrinth paginates in 100-version pages (up to 1,000). Docker Hub tag discovery paginates in 100-tag pages (up to 1,000) and skips the floating `latest` tag.

Catalog metadata also supports an HTTPS official website, HTTPS logo URL, supported operating systems, supported architectures, required runtime, and default version. These fields are descriptive compatibility metadata; they do not themselves install host packages or prove compatibility. Release pages show upstream source URLs, compatibility labels, and available SHA-256 values from the official Go and MongoDB feeds.

## Add a catalog entry

1. Open **Admin → Software & Versions → Add Software**.
2. Enter a unique lowercase identifier and a name.
3. Enter service type values exactly as used by NIMBUS (for example `minecraft`, `discord`, `website`, `backend`, `database`, or `docker`).
4. Select an implemented source adapter and fill its repository/project fields. PaperMC and Purpur adapters additionally require the exact Minecraft version (for example `1.21.11`) whose server builds should be discovered.
5. Optionally configure a Docker image template ending in `:{version}`, such as `example/application:{version}`. Use this only when the upstream project's published Docker tags actually match the version identifiers returned by the selected source. You may also supply installer environment overrides (for example `{"TYPE":"PAPER","EULA":"TRUE"}`); keys and values are validated and passed to the Node Agent, which merges them over the existing container environment.
6. Choose auto-sync frequency and whether stable discoveries may be published automatically.
7. Save the entry and select it in the catalog.

Do not configure an image template unless the image is trusted and the tag convention has been verified. The adapter runs the image as a container; it does not install arbitrary host packages.

## Fetch and publish versions

- **Fetch versions** calls the configured official source and stages a preview of discovered releases.
- Admins can import selected new versions or import all discovered versions in one operation. Existing versions are identified in the preview and are not duplicated.
- Existing software/version pairs are detected by a unique database index and are not duplicated. Preview data expires after 24 hours.
- New versions are pending approval by default.
- If auto-publishing is enabled, only non-prerelease discoveries are published automatically. Prereleases remain pending.
- Select individual versions to publish or disable them. The bulk actions support publishing, disabling, and deprecating selected versions. A version can be marked recommended only after it is published and is not deprecated; this is enforced by the API for both single and bulk actions.
- Manual version entry remains available as a fallback and creates a pending version.
- Existing versions are not deleted when a source request fails. Sync status and a bounded history are stored on the software record.

## Automatic synchronization

Automatic sync runs in the API process once per minute and checks each enabled catalog entry's configured interval (6 hours, 12 hours, 24 hours, or 7 days). A database lease prevents two API instances from synchronizing the same software entry at the same time. If a source fails, the existing catalog remains intact and the next interval can retry.

This is an in-process scheduler, not a durable external job queue. For multi-region or high-availability deployments, move this work to a dedicated persistent worker before scaling the API horizontally.

## Customer software changes

Customers can view catalog entries matching their service type. A version is selectable only when it is published, not deprecated, and the catalog entry has a configured Docker image template adapter.

For a supported container change, NIMBUS:

1. Verifies the customer's ownership of the service.
2. Verifies the catalog entry, service type, version publication state, and image template.
3. Creates a local pre-update backup through the existing Node Agent backup endpoint.
4. Pulls the target image before stopping the existing container.
5. Stops and renames the previous container while retaining the same service data directory.
6. Starts the new image using the service resource limits and configured startup command, while retaining the previous stopped container.
7. Checks that the running container reports the requested image and waits for a configured Docker health check to become healthy.
8. Saves the service and operation records, then asks the Node Agent to remove the previous container in a separate commit step.
9. If the database update fails after the new container starts, asks the Node Agent to restore the retained previous container. If final cleanup fails, the previous container is kept and an administrator warning is recorded.

Operation history is available on the service's **Software** tab. The current verification is container-level: running state, configured image, and Docker health status when a health check exists. An application without a Docker health check cannot receive an application-specific health guarantee from this adapter.

The current adapter is intentionally limited to Docker image-template upgrades. A catalog record without this adapter can be discovered and published, but cannot be installed through the customer workflow. The Admin catalog form exposes the image template and validated environment overrides so compatible containerized software can be configured without editing MongoDB manually.

## Node credential compatibility

Control-plane-to-agent requests now use the per-node enrollment credential encrypted at rest by the API. Nodes enrolled before this field was added do not yet have the encrypted credential. For those nodes, an Owner/Admin must use **Admin → Nodes → Revoke Credentials**, then run the newly generated node installer command on that node to re-enroll it before agent-backed operations will work.

Never share enrollment tokens or node credentials in support tickets or public channels.

## Regression smoke coverage

The main API smoke suite now also checks Owner-only catalog access, manual version creation and HTTPS source validation, publish-before-recommend rules, customer service ownership for software options, rejection of software changes without a real installer, and backend rejection of customer VPS operating-system changes. These checks run in the existing CI integration job; source-adapter network behavior and real agent-backed upgrades still require dedicated tests.

## Security boundaries and current limitations

- Catalog management endpoints are Owner/Admin-only.
- Customer options and operation history call the existing service ownership check.
- Customer software changes cannot target VPS/VDS services. Customer OS changes are rejected by the backend, not merely hidden in the UI.
- The current work does **not** implement an Admin VPS/VDS OS-image management workflow.
- Dedicated source adapters are not yet implemented for every software family in the master prompt (including MongoDB, arbitrary Docker registries, PHP, Go, Java, .NET, and Lavalink). Use an approved GitHub release source only when that project's official release metadata is authoritative; otherwise keep the entry manual until a proper adapter is added.
- The complete catalog approval workflow, durable job queue, source-specific compatibility matrix, and application-level health probes remain follow-up work.
- Do not use the existing **Reinstall** action to change software. Reinstall is destructive and removes the service data directory.


## Re-enrolling an existing node after credential revocation

When an Owner/Admin revokes a node credential, the Nodes page generates an installer command containing `--force-reenroll`. Run that command on the existing node. The installer stops the agent, removes only the saved agent token and node ID, preserves service data and the TLS certificate, installs the current agent binary, and starts it with the fresh single-use enrollment token. Do not use `--force-reenroll` for a routine binary refresh when the node credential has not been revoked.
