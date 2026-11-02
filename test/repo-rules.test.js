import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const isIgnored = (path) => spawnSync('git', ['check-ignore', '--quiet', '--no-index', path]).status === 0;

test('secrets and member data are ignored by git', () => {
    for (const path of ['.env', '.env.local', 'data/results.csv', 'data/.env']) {
        assert.ok(isIgnored(path), `${path} must be ignored`);
    }
});

test('.env.example stays in git and holds no real values', () => {
    assert.ok(!isIgnored('.env.example'));

    const example = readFileSync('.env.example', 'utf8');
    assert.match(example, /^DISCORD_TOKEN=$/m);
    assert.match(example, /^DISCORD_SERVER_ID=$/m);
});

test('project files never use the em dash', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
        .split('\n')
        .filter((file) => /\.(md|js|json|css|html|txt|bat|command|example)$/.test(file));

    for (const file of files) {
        assert.ok(!readFileSync(file, 'utf8').includes(String.fromCodePoint(0x2014)), `${file} contains an em dash`);
    }
});
