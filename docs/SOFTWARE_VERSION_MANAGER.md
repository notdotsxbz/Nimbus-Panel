# Software & Version Manager

## Current scope

The Software & Versions area is available to Owner/Admin accounts at **Admin → Software & Versions**. It stores software catalog entries and version records in the existing MongoDB database, and writes catalog actions to the existing audit log.

The currently implemented official-source adapters are:

- **GitHub Releases** — release metadata from a configured public `owner/repository`.
- **Minecraft Vanilla** — official Mojang version manifest, including release type, release date and manifest checksum.
- **Node.js releases** — the official Node.js distribution index.
- **Modrinth** — versions from a configured Modrinth project ID.
- **Docker Hub tags** — tags from a configured public Docker Hub namespace/repository.
- **Manual** — fallback for software without an implemented source adapter.

GitHub discovery follows up to five pages of 100 releases. Node.js uses the official distribution index. Modrinth paginates in 100-version pages (up to 1,000). Docker Hub tag discovery paginates in 100-tag pages (up to 1,000) and skips the floating `latest` tag.

## Add a catalog entry

1. Open **Admin → Software & Versions → Add Software**.
2. Enter a unique lowercase identifier and a name.
3. Enter service type values exactly as used by NIMBUS (for example `minecraft`, `discord`, `website`, `backend`, `database`, or `docker`).
4. Select an implemented source adapter and fill its repository/project fields.
5. Configure a trusted Docker image and put `{version}` either in its image tag (for example `ghcr.io/example/application:{version}`) or in a version-bearing environment value. For Minecraft with `itzg/minecraft-server`, use a stable image tag such as `itzg/minecraft-server:java21` and environment overrides such as `TYPE=PAPER`, `VERSION={version}`, and `EULA=TRUE`. The Node Agent merges these values over the existing container environment. This verifies the replacement container/image and configured environment; application-specific version verification still depends on the image health check and is not a universal binary-level probe.
6. Choose auto-sync frequency and whether stable discoveries may be published automatically.
7. Save the entry and select it in the catalog.

Do not configure an image template unless the image is trusted and the tag convention has been verified. The adapter runs the image as a container; it does not install arbitrary host packages.

## Fetch and publish versions

- **Fetch versions** calls the configured official source and stages a preview of discovered releases.
- Admins can import selected new versions or import all discovered versions in one operation. Existing versions are identified in the preview and are not duplicated.
- Existing software/version pairs are detected by a unique database index and are not duplicated. Preview data expires after 24 hours.
- New versions are pending approval by default.
- If auto-publishing is enabled, only non-prerelease discoveries are published automatically. Prereleases remain pending.
- Select individual versions to publish or disable them. The bulk actions support publishing, disabling, and deprecating selected versions.
- Manual version entry remains available as a fallback and creates a pending version.
- Existing versions are not deleted when a source request fails. Sync status and a bounded history are stored on the software record.

## Automatic synchronization

Automatic sync runs in the API process every 15 seconds and checks each enabled catalog entry's configured interval (6 hours, 12 hours, 24 hours, or 7 days). A database lease prevents two API instances from synchronizing the same software entry at the same time. If a source fails, the existing catalog remains intact and the next interval can retry.

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

## Security boundaries and current limitations

- Catalog management endpoints are Owner/Admin-only.
- Customer options and operation history call the existing service ownership check.
- Customer software changes cannot target VPS/VDS services. Customer OS changes are rejected by the backend, not merely hidden in the UI.
- Admins can maintain VPS/VDS OS-image catalog metadata as `operating-system` entries with KVM/libvirt image IDs, minimum RAM, architecture and manual OS versions. These entries are not exposed to customers. The repository still has no virtualization Node Agent/provider, so it cannot apply or reinstall an OS; the UI explicitly labels these records as metadata-only.
- Dedicated source adapters are not yet implemented for every software family in the master prompt (including MongoDB, arbitrary Docker registries, PHP, Go, Java, .NET, and Lavalink). Use an approved GitHub release source only when that project's official release metadata is authoritative; otherwise keep the entry manual until a proper adapter is added.
- Source discovery now includes Go, .NET, PaperMC, Purpur, Fabric, Quilt, Temurin Java, Forge and NeoForge official metadata. Python, PHP, MongoDB and Lavalink can use the generic GitHub Releases or Docker Hub tags adapters when the configured official source and image tag convention are verified; there are not dedicated source-specific adapters for each of those products yet.
- The current installer still supports Docker image-template operations only. It does not implement native installers for every runtime, a virtualization provider for Admin VPS/VDS OS replacement, or application-specific health probes for every software family.
- Do not use the existing **Reinstall** action to change software. Reinstall is destructive and removes the service data directory.


## Re-enrolling an existing node after credential revocation

When an Owner/Admin revokes a node credential, the Nodes page generates an installer command containing `--force-reenroll`. Run that command on the existing node. The installer stops the agent, removes only the saved agent token and node ID, preserves service data and the TLS certificate, installs the current agent binary, and starts it with the fresh single-use enrollment token. Do not use `--force-reenroll` for a routine binary refresh when the node credential has not been revoked.
