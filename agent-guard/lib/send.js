/**
 * Background sender. The hook starts this detached and exits immediately,
 * so reporting to the dashboard never slows the developer down.
 */
"use strict";
require("./core").flush().catch(() => {}).finally(() => process.exit(0));
