export function pageCount(total, pageSize) {
    return Math.max(1, Math.ceil(total / pageSize));
}

// Keeps a page number inside the list, so paging can't go past either end.
export function clampPage(page, pages) {
    return Math.min(Math.max(page, 0), pages - 1);
}
