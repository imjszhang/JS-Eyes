#!/usr/bin/env node

/**
 * JS Eyes CLI
 *
 * Usage:
 *   node cli/cli.js <command> [options]
 *
 * Commands:
 *   build [site|chrome|firefox|all]  Build targets (default: all)
 *   bump <version>                   Sync version across manifests
 *   commit [--message "..."] [--all] Git add + commit
 *   sync [--no-build] [--no-push]   Build + commit + push
 *   release [--draft] [--assets]     Create GitHub release (requires gh CLI)
 *
 * Options:
 *   --no-sign       Skip Firefox signing
 *   --clean         Clean docs/ before site build
 *   --lang <locale> Set language (en-US / zh-CN)
 *   --help, -h      Show help
 */

const i18n = require('./i18n');
const { buildSite, buildChrome, buildFirefox, bump, getVersion } = require('./lib/builder');
const { gitStatus, gitAddAll, gitCommit, gitPush, gitDiffStat, gitTag, gitTagExists, generateCommitMessage, ghRelease, ghAvailable } = require('./lib/git');
const fs = require('fs');
const path = require('path');

i18n.init(process.argv.slice(2));
const t = i18n.t;

function parseArgs(argv) {
    const raw = argv.slice(2);
    const args = raw.filter(a => a !== '--lang' && !i18n.SUPPORTED.includes(a));
    const command = args[0] || '';
    const sub = args[1] || '';
    const flags = {};
    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        }
    }
    return { command, sub, flags };
}

function log(msg) { console.error(msg); }

// ── Build ────────────────────────────────────────────────────────────

async function cmdBuild(sub, flags) {
    const noSign = !!flags['no-sign'];
    const clean = !!flags['clean'];
    const target = sub || 'all';

    switch (target) {
        case 'site':
            buildSite(t, { clean });
            break;
        case 'chrome':
            await buildChrome(t);
            break;
        case 'firefox':
            await buildFirefox(t, !noSign);
            break;
        case 'all': {
            const version = getVersion();
            console.log('========================================');
            console.log(`   ${t('tool.name')}`);
            console.log(`   ${t('tool.version').replace('{version}', version)}`);
            console.log('========================================');
            console.log('');
            console.log('[1/3] Site');
            buildSite(t, { clean });
            console.log('');
            console.log('[2/3] Chrome');
            await buildChrome(t);
            console.log('');
            console.log('[3/3] Firefox');
            await buildFirefox(t, !noSign);
            console.log('');
            console.log('========================================');
            console.log(`   ${t('tool.allDone')}`);
            console.log('========================================');
            break;
        }
        default:
            console.error(t('help.unknownTarget').replace('{target}', target));
            process.exit(1);
    }
}

// ── Commit ───────────────────────────────────────────────────────────

function cmdCommit(flags) {
    try {
        const status = gitStatus();
        if (status.clean) {
            log(t('git.clean'));
            return;
        }

        log(t('git.staging'));
        gitAddAll();

        const { files } = gitDiffStat();
        if (files.length === 0) {
            log(t('git.nothingStaged'));
            return;
        }

        const message = flags.message || flags.m || generateCommitMessage(files);
        log(`${t('git.committing')} ${message}`);
        const { hash } = gitCommit(message);

        log(`${t('git.committed')} ${hash}`);
        log(`  ${t('git.branch')}: ${status.branch}`);
        log(`  ${t('git.files')}: ${files.length}`);
    } catch (err) {
        log(`  ✗ ${err.message}`);
        process.exit(1);
    }
}

// ── Sync ─────────────────────────────────────────────────────────────

async function cmdSync(flags) {
    try {
        const noBuild = !!flags['no-build'];
        const noPush = !!flags['no-push'];
        const noSign = !!flags['no-sign'];

        const status = gitStatus();
        log(`${t('git.branch')}: ${status.branch}`);

        if (!noBuild) {
            log('');
            log(`── ${t('git.stepBuild')} ──`);
            buildSite(t, { clean: true });
        } else {
            log(t('git.buildSkipped'));
        }

        log('');
        log(`── ${t('git.stepStage')} ──`);
        gitAddAll();

        const { files } = gitDiffStat();
        if (files.length === 0) {
            log(t('git.cleanAfterBuild'));
            return;
        }

        const message = flags.message || flags.m || generateCommitMessage(files);
        log('');
        log(`── ${t('git.stepCommit')} ──`);
        log(`${t('git.message')}: ${message}`);
        const { hash } = gitCommit(message);
        log(`${t('git.committed')} ${hash} (${files.length} files)`);

        if (!noPush) {
            log('');
            log(`── ${t('git.stepPush')} ──`);
            log(`${t('git.pushing')} origin/${status.branch} ...`);
            gitPush('origin', status.branch);
            log(t('git.pushDone'));
        } else {
            log(t('git.pushSkipped'));
        }
    } catch (err) {
        log(`  ✗ ${err.message}`);
        process.exit(1);
    }
}

// ── Release ──────────────────────────────────────────────────────────

function cmdRelease(flags) {
    try {
        if (!ghAvailable()) {
            log(`  ✗ ${t('release.ghMissing')}`);
            log(`  ${t('release.ghInstall')}`);
            process.exit(1);
        }

        const version = getVersion();
        const tag = `v${version}`;
        const draft = !!flags['draft'];

        if (gitTagExists(tag)) {
            log(`  ⚠ ${t('release.tagExists').replace('{tag}', tag)}`);
        }

        log(`${t('release.creating')} ${tag} ...`);

        const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
        const assets = [];
        if (fs.existsSync(DIST_DIR)) {
            const distFiles = fs.readdirSync(DIST_DIR).filter(f => f.includes(version));
            for (const f of distFiles) {
                assets.push(path.join(DIST_DIR, f));
            }
        }

        if (assets.length > 0) {
            log(`  ${t('release.assets')}:`);
            assets.forEach(a => log(`    - ${path.basename(a)}`));
        }

        const title = `JS Eyes ${tag}`;
        const notes = `Release ${tag}`;
        const { url } = ghRelease(tag, title, notes, assets);

        log(`  ✓ ${t('release.done')}`);
        log(`  ${t('release.url')}: ${url}`);
    } catch (err) {
        log(`  ✗ ${err.message}`);
        process.exit(1);
    }
}

// ── Help ─────────────────────────────────────────────────────────────

function showHelp() {
    console.log(t('tool.name'));
    console.log('');
    console.log(t('help.usage'));
    console.log('');
    console.log(t('help.commands'));
    console.log(t('help.cmdBuildSite'));
    console.log(t('help.cmdBuildChrome'));
    console.log(t('help.cmdBuildFirefox'));
    console.log(t('help.cmdBuildAll'));
    console.log(t('help.cmdBump'));
    console.log(t('help.cmdCommit'));
    console.log(t('help.cmdSync'));
    console.log(t('help.cmdRelease'));
    console.log('');
    console.log(t('help.options'));
    console.log(t('help.optNoSign'));
    console.log(t('help.optClean'));
    console.log(t('help.optMessage'));
    console.log(t('help.optNoBuild'));
    console.log(t('help.optNoPush'));
    console.log(t('help.optDraft'));
    console.log(t('help.optLang'));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
    const { command, sub, flags } = parseArgs(process.argv);

    switch (command) {
        case 'build':
            await cmdBuild(sub, flags);
            break;
        case 'bump':
            bump(t, sub);
            break;
        case 'commit':
            cmdCommit(flags);
            break;
        case 'sync':
            await cmdSync(flags);
            break;
        case 'release':
            cmdRelease(flags);
            break;
        case '--help':
        case '-h':
        case 'help':
            showHelp();
            break;
        default:
            if (command) {
                console.error(t('help.unknownCmd').replace('{cmd}', command));
                console.log('');
            }
            showHelp();
            process.exit(command ? 1 : 0);
    }
}

main().catch(e => {
    console.error(t('help.buildError').replace('{msg}', e.message));
    process.exit(1);
});
