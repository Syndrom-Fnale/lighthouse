/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import fs from 'fs';

import esbuild from 'esbuild';
import esMain from 'es-main';

import * as plugins from './esbuild-plugins.js';
import {LH_ROOT} from '../root.js';
import {getIcuMessageIdParts} from '../shared/localization/format.js';
import {locales} from '../shared/localization/locales.js';
import {UIStrings as FlowUIStrings} from '../flow-report/src/i18n/ui-strings.js';

/**
 * Extract only the strings needed for the flow report into
 * a script that sets a global variable `strings`, whose keys
 * are locale codes (en-US, es, etc.) and values are localized UIStrings.
 */
function buildFlowStrings() {
  const strings = /** @type {Record<LH.Locale, string>} */ ({});

  for (const [locale, lhlMessages] of Object.entries(locales)) {
    const localizedStrings = Object.fromEntries(
      Object.entries(lhlMessages).map(([icuMessageId, v]) => {
        const {filename, key} = getIcuMessageIdParts(icuMessageId);
        if (!filename.endsWith('ui-strings.js') || !(key in FlowUIStrings)) {
          return [];
        }

        return [key, v.message];
      })
    );
    strings[/** @type {LH.Locale} */ (locale)] = localizedStrings;
  }

  return 'export default ' + JSON.stringify(strings, null, 2) + ';';
}

function buildStandaloneReport() {
  return esbuild.build({
    entryPoints: ['report/clients/standalone.js'],
    outfile: 'dist/report/standalone.js',
    format: 'iife',
    bundle: true,
    minify: true,
  });
}

const buildReportBulkLoader = plugins.bulkLoader([
  plugins.partialLoaders.inlineFs,
  plugins.partialLoaders.rmGetModuleDirectory,
]);

async function buildFlowReport() {
  return esbuild.build({
    entryPoints: ['flow-report/clients/standalone.ts'],
    outfile: 'dist/report/flow.js',
    format: 'iife',
    bundle: true,
    minify: true,
    plugins: [
      plugins.ignoreBuiltins(),
      plugins.replaceModules({
        [`${LH_ROOT}/flow-report/src/i18n/localized-strings.js`]: buildFlowStrings(),
        [`${LH_ROOT}/shared/localization/locales.js`]: 'export const locales = {}',
      }),
      buildReportBulkLoader,
    ],
  });
}

async function buildEsModulesBundle() {
  // Include the type detail for bundle.esm.d.ts generation
  const i18nModuleShim = `
/**
 * Returns a new LHR with all strings changed to the new requestedLocale.
 * @param {LH.Result} lhr
 * @param {LH.Locale} requestedLocale
 * @return {{lhr: LH.Result, missingIcuMessageIds: string[]}}
 */
export function swapLocale(lhr, requestedLocale) {
  // Stub function only included for types
  return {
    lhr,
    missingIcuMessageIds: [],
  };
}

/**
 * Populate the i18n string lookup dict with locale data
 * Used when the host environment selects the locale and serves lighthouse the intended locale file
 * @see https://docs.google.com/document/d/1jnt3BqKB-4q3AE94UWFA0Gqspx8Sd_jivlB7gQMlmfk/edit
 * @param {LH.Locale} locale
 * @param {Record<string, {message: string}>} lhlMessages
 */
function registerLocaleData(locale, lhlMessages) {
  // Stub function only included for types
}

/**
 * Returns whether the requestedLocale is registered and available for use
 * @param {LH.Locale} requestedLocale
 * @return {boolean}
 */
function hasLocale(requestedLocale) {
  // Stub function only included for types
  return false;
}
export const format = {registerLocaleData, hasLocale};
`;

  return esbuild.build({
    entryPoints: ['report/clients/bundle.js'],
    outfile: 'dist/report/bundle.esm.js',
    format: 'esm',
    bundle: true,
    minify: true,
    plugins: [
      plugins.replaceModules({
        // Exclude this 30kb from the devtools bundle for now.
        [`${LH_ROOT}/shared/localization/i18n-module.js`]: i18nModuleShim,
      }),
    ],
  });
}

async function buildUmdBundle() {
  const result = await esbuild.build({
    entryPoints: ['report/clients/bundle.js'],
    outfile: 'dist/report/bundle.umd.js',
    // currently there is no umd support in esbuild.
    // so we take the output and create our own umd bundle.
    // https://github.com/evanw/esbuild/pull/1331
    write: false,
    format: 'iife',
    globalName: 'reportExports',
    bundle: true,
    minify: false,
    plugins: [
      plugins.ignoreBuiltins(),
      plugins.replaceModules({
        [`${LH_ROOT}/shared/localization/locales.js`]: 'export const locales = {}',
      }),
      buildReportBulkLoader,
    ],
  });

  const code = `
(function(root, factory) {
  if (typeof define === "function" && define.amd) {
    define(factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.report = factory();
  }
}(typeof self !== "undefined" ? self : this, function() {
  "use strict";
  ${result.outputFiles[0].text.replace('"use strict";\n', '')};
  return reportExports;
}));
`;

  fs.writeFileSync(result.outputFiles[0].path, code);
}

async function main() {
  if (process.argv.length <= 2) {
    await Promise.all([
      buildStandaloneReport(),
      buildFlowReport(),
      buildEsModulesBundle(),
      buildUmdBundle(),
    ]);
  }

  if (process.argv.includes('--psi')) {
    console.error('--psi build removed. use --umd instead.');
    process.exit(1);
  }
  if (process.argv.includes('--standalone')) {
    await buildStandaloneReport();
  }
  if (process.argv.includes('--flow')) {
    await buildFlowReport();
  }
  if (process.argv.includes('--esm')) {
    await buildEsModulesBundle();
  }
  if (process.argv.includes('--umd')) {
    await buildUmdBundle();
  }
}

if (esMain(import.meta)) {
  await main();
}

export {
  buildStandaloneReport,
  buildFlowReport,
  buildUmdBundle,
};
