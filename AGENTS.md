# FlexCraft Agent Notes

- Work from `C:\Projects\minecraft-launcher-win` for this project.
- After code/content changes, run the relevant checks before handing off. For launcher changes, use `npm run lint` and `npm run build`; for release changes, package before deploy.
- Unless the user explicitly says not to, commit completed work automatically with a clear Russian or English commit message.
- Unless the user explicitly says not to, deploy completed production-ready changes automatically after successful checks. Use `.\deploy-vk-vm.cmd all` when launcher downloads or site files changed, `.\deploy-vk-vm.cmd site` for site-only changes, and `.\deploy-vk-vm.cmd existing` only when the current `dist` output is intentionally being reused.
- Do not expose private keys, passwords, tokens, or service-account secrets in commits, logs, or responses.
