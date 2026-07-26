# ClaudeMonkey

> **ClaudeMonkey** is a fork of [Violentmonkey](https://github.com/violentmonkey/violentmonkey)
> (MIT, by Gerald). It keeps the full userscript manager but makes the default action a
> textbox: you describe how you want the current site changed, and a locally-running
> **Claude Code** instance writes or edits the userscript for that site (using your Claude
> subscription via a native-messaging bridge — see [`bridge/`](bridge/)). Setup and usage
> instructions are in [SETUP.md](SETUP.md). All credit for the underlying userscript engine
> goes to the Violentmonkey authors; the original README follows.

---

# Violentmonkey

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/jinjaccalgkegednnccohejagnlnfdag.svg)](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
[![Firefox Add-ons](https://img.shields.io/amo/v/violentmonkey.svg)](https://addons.mozilla.org/firefox/addon/violentmonkey)
[![Microsoft Edge Add-on](https://img.shields.io/badge/dynamic/json?label=microsoft%20edge%20add-on&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Feeagobfjdenkkddmbclomhiblgggliao)](https://microsoftedge.microsoft.com/addons/detail/eeagobfjdenkkddmbclomhiblgggliao)

Violentmonkey provides userscripts support for browsers.
It works on browsers with [WebExtensions](https://developer.mozilla.org/en-US/Add-ons/WebExtensions) support.

More details can be found [here](https://violentmonkey.github.io/).

Join our Discord server:

[![Discord](https://img.shields.io/discord/995346102003965952?label=discord&logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/XHtUNSm6Xc)

## Workflows

### Development

Install [Node.js](https://nodejs.org/) and PNPM.
The version of Node.js should match `"node"` key in `package.json`.

``` sh
# Install dependencies
$ pnpm i

# Watch and compile
$ pnpm dev
```

Then load the extension from 'dist/'.

### Test + lint

``` sh
$ pnpm run ci
```

### Build

``` sh
# Build for normal releases
$ pnpm build

# Build for self-hosted release that has an update_url
$ pnpm build:selfHosted
```

## Related Projects

- [Violentmonkey for Opera Presto](https://github.com/violentmonkey/violentmonkey-oex)
- [Violentmonkey for Maxthon](https://github.com/violentmonkey/violentmonkey-mx)
