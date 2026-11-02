import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPage, pageCount } from '../public/paging.js';

test('counts pages and always has at least one', () => {
    assert.equal(pageCount(900, 25), 36);
    assert.equal(pageCount(901, 25), 37);
    assert.equal(pageCount(0, 25), 1);
});

test('paging cannot go before the first page or past the last', () => {
    assert.equal(clampPage(-1, 10), 0);
    assert.equal(clampPage(-5, 10), 0);
    assert.equal(clampPage(10, 10), 9);
    assert.equal(clampPage(4, 10), 4);
});
