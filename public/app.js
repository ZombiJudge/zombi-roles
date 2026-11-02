import { clampPage, pageCount } from './paging.js';

const DEFAULT_PAGE_SIZE = 50;
const PER_PAGE_KEY = 'zombi-roles-per-page';
const SKIP_ROLE_KEY = 'zombi-roles-skip-role';
const MAX_NOTICE_LINES = 8;
const SUCCESS_NOTICE_MS = 6000;
const CONNECTION_CHECK_MS = 3000;
const BUILD_VIEWS = { members: 1, roles: 2, preview: 3, progress: 4 };
const session = document.querySelector('meta[name="zombi-session"]').content;
const element = (id) => document.getElementById(id);

const state = {
    settings: null,
    members: [],
    filteredIds: null,
    search: '',
    selected: new Set(),
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    perPage: 'fit',
    who: null,
    preview: null,
    batch: null,
    polling: null,
    update: { enabled: false },
    askedForRole: false,
    restarting: false,
};

async function api(path, body) {
    const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Zombi-Session': session, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
        throw new Error('That did not work because Zombi Roles is not running. Double-click Zombi Roles Launcher.');
    });

    if (path.endsWith('.csv') && response.ok) {
        return response.text();
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error ?? 'Something went wrong.');
    }

    return data;
}

function clearNotices() {
    element('toasts').querySelectorAll('.toast:not([data-sticky])').forEach((toast) => toast.remove());
}

// A pop-up in the corner of the window. Only success messages close by themselves,
// so nobody has to read a problem against the clock.
function notify(message, { kind = 'error', details = [], action: extra, actions = extra ? [extra] : [], sticky = false } = {}) {
    const toast = document.createElement('div');
    const body = document.createElement('div');
    const text = document.createElement('p');
    const close = document.createElement('button');

    toast.className = `toast toast-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.toggleAttribute('data-sticky', sticky);
    body.className = 'toast-body';
    text.textContent = message;
    body.append(text);

    if (details.length > 0) {
        const list = document.createElement('ul');
        const shown = details.slice(0, MAX_NOTICE_LINES);
        const lines = details.length > shown.length ? [...shown, `And ${details.length - shown.length} more.`] : shown;

        list.replaceChildren(
            ...lines.map((line) => {
                const item = document.createElement('li');
                item.textContent = line;
                return item;
            }),
        );
        body.append(list);
    }

    if (actions.length > 0) {
        const row = document.createElement('div');
        row.className = 'button-row';

        for (const { label, run } of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'button button-small';
            button.textContent = label;
            button.addEventListener('click', () => {
                toast.remove();
                run();
            });
            row.append(button);
        }

        body.append(row);
    }

    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = 'X';
    close.setAttribute('aria-label', 'Close notification');
    close.addEventListener('click', () => {
        toast.remove();
        element('main').focus();
    });

    toast.append(body, close);
    element('toasts').append(toast);

    if (kind === 'success') {
        setTimeout(() => toast.remove(), SUCCESS_NOTICE_MS);
    }
}

// Runs a button's work, keeping it from being clicked twice and showing any error.
function action(button, work) {
    button.addEventListener('click', async () => {
        clearNotices();
        button.disabled = true;

        try {
            await work();
        } catch (error) {
            notify(error.message);
        } finally {
            button.disabled = false;
        }
    });
}

function show(view) {
    for (const section of document.querySelectorAll('section[id^="view-"]')) {
        section.hidden = section.id !== `view-${view}`;
    }

    const step = BUILD_VIEWS[view];
    const stepper = element('stepper');
    stepper.hidden = step === undefined;

    for (const item of stepper.children) {
        const number = Number(item.dataset.step);
        item.classList.toggle('is-done', number < step);

        if (number === step) {
            item.setAttribute('aria-current', 'step');
        } else {
            item.removeAttribute('aria-current');
        }
    }

    const nav = step ? 'build' : view;

    for (const button of document.querySelectorAll('[data-nav]')) {
        if (button.dataset.nav === nav) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    }

    window.scrollTo(0, 0);
    document.querySelector(`#view-${view} h1`).focus();

    if (view === 'members') {
        renderMembers();
    }
}

const displayName = (member) => member.nickname ?? member.globalName ?? member.username;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function save(filename, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

function visibleMembers() {
    const allowed = state.filteredIds && new Set(state.filteredIds);
    const search = state.search.toLowerCase();

    return state.members.filter(
        (member) =>
            (!allowed || allowed.has(member.id)) &&
            [member.username, member.nickname, member.globalName].some((name) => name?.toLowerCase().includes(search)),
    );
}

function cell(row, text) {
    const td = row.insertCell();
    td.textContent = text;
    return td;
}

function loadPerPage() {
    try {
        return localStorage.getItem(PER_PAGE_KEY) ?? 'fit';
    } catch {
        return 'fit';
    }
}

function savePerPage(value) {
    try {
        localStorage.setItem(PER_PAGE_KEY, value);
    } catch {
        // Only a convenience, so the panel works the same without it.
    }
}

function currentPageSize(total) {
    if (state.perPage === 'fit') {
        return fittedPageSize();
    }

    return state.perPage === 'all' ? Math.max(total, 1) : Number(state.perPage);
}

// How many rows fit without scrolling, so a page of members always fills the space it has.
function fittedPageSize() {
    const wrap = element('table-wrap');

    if (!matchMedia('(width >= 40rem) and (height >= 34rem)').matches || wrap.clientHeight === 0) {
        return DEFAULT_PAGE_SIZE;
    }

    const headerHeight = wrap.querySelector('thead').offsetHeight;
    const rowHeight = element('member-rows').rows[0]?.offsetHeight || 37;

    return Math.max(1, Math.floor((wrap.clientHeight - headerHeight) / rowHeight));
}

function renderMembers() {
    const members = visibleMembers();
    const rows = element('member-rows');

    const wrap = element('table-wrap');

    wrap.classList.toggle('is-scrolling', state.perPage !== 'fit');
    state.pageSize = currentPageSize(members.length);

    const pages = pageCount(members.length, state.pageSize);
    state.page = clampPage(state.page, pages);
    rows.replaceChildren();
    wrap.scrollTop = 0;

    for (const member of members.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
        const row = rows.insertRow();
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = state.selected.has(member.id);
        box.setAttribute('aria-label', `Select ${displayName(member)}`);
        box.addEventListener('change', () => {
            if (box.checked) {
                state.selected.add(member.id);
            } else {
                state.selected.delete(member.id);
            }

            renderCount();
        });
        row.insertCell().append(box);

        const name = cell(row, displayName(member));

        if (member.isBot) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = ' (bot)';
            name.append(tag);
        }

        cell(row, member.username);
    }

    element('page-label').textContent = `Page ${state.page + 1} of ${pages}`;
    element('page-previous').disabled = state.page === 0;
    element('page-next').disabled = state.page >= pages - 1;
    renderCount();
}

function renderCount() {
    element('member-count').textContent = `${visibleMembers().length} shown, ${state.selected.size} selected`;
    element('select-all').disabled = visibleMembers().length === 0;
}

function renderRoles() {
    const { manageable = [], blocked = [] } = state.settings;

    for (const [id, name] of [['roles-add', 'add'], ['roles-remove', 'remove']]) {
        const list = element(id);
        list.replaceChildren();

        for (const role of manageable) {
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.name = name;
            box.value = role.id;
            box.addEventListener('change', () => syncRoleBoxes(name, role.id, box.checked));
            label.append(box, role.name);
            list.append(label);
        }

        if (manageable.length === 0) {
            list.textContent = 'No roles are available. Move the bot role higher in Discord.';
        }
    }

    element('blocked-details').hidden = blocked.length === 0;
    element('blocked-list').replaceChildren(
        ...blocked.map(({ name, reason }) => {
            const item = document.createElement('li');
            item.textContent = `${name}: ${reason}`;
            return item;
        }),
    );
}

// A role can't be added and removed at once, so ticking one side turns off the other.
function syncRoleBoxes(name, roleId, checked) {
    const other = name === 'add' ? 'remove' : 'add';
    const box = document.querySelector(`input[name="${other}"][value="${roleId}"]`);
    box.disabled = checked;
}

const checkedRoles = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(({ value }) => value);

function list(title, items) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const ul = document.createElement('ul');

    summary.textContent = `${title} (${items.length})`;
    ul.replaceChildren(
        ...items.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        }),
    );
    details.append(summary, ul);
    return details;
}

const changeText = ({ action: verb, roleName, memberName }) =>
    `${verb === 'add' ? 'Add' : 'Remove'} ${roleName} ${verb === 'add' ? 'to' : 'from'} ${memberName}`;

function renderPreview(preview) {
    state.preview = preview;

    const { counts, changes, alreadySet, unresolved, ambiguous } = preview;
    const stats = [
        ['Matched', counts.matched],
        ['Unresolved', counts.unresolved],
        ['Ambiguous', counts.ambiguous],
        ['Already set', counts.alreadySet],
        ['Will change', counts.willChange],
    ];

    element('preview-title').textContent = preview.kind === 'undo' ? 'Undo preview' : 'Preview';
    element('preview-stats').replaceChildren(
        ...stats.map(([label, value]) => {
            const box = document.createElement('div');
            const term = document.createElement('dt');
            const detail = document.createElement('dd');
            term.textContent = label;
            detail.textContent = value;
            box.append(term, detail);
            return box;
        }),
    );

    const lists = [list('Will change', changes.map(changeText))];

    if (alreadySet.length) {
        lists.push(list('Already set, skipped', alreadySet.map(changeText)));
    }

    if (unresolved.length) {
        lists.push(list('Unresolved, skipped', unresolved));
    }

    if (ambiguous.length) {
        lists.push(list('Ambiguous, skipped', ambiguous.map(({ name, candidates }) => `${name}: ${candidates.join(', ')}`)));
    }

    lists[0].open = true;
    element('preview-lists').replaceChildren(...lists);
    element('preview-long').hidden = !preview.tooLongForDiscordProgress;
    element('preview-intro').textContent = changes.length === 0 ? 'Everything is already set, so there is nothing to change.' : 'Nothing has changed yet.';
    element('preview-confirm').hidden = changes.length === 0;
    element('preview-confirm').textContent = `Confirm ${plural(changes.length, 'change')}`;
    show('preview');
}

function renderBatch(status) {
    state.batch = status;

    const running = status.state === 'running';
    const bar = element('progress-bar');

    element('progress-title').textContent = `Batch ${status.batch}`;
    bar.max = Math.max(status.total, 1);
    bar.value = status.done;
    element('progress-text').textContent = `${status.done} of ${plural(status.total, 'change')} done${running && status.stopping ? ', stopping' : ''}`;

    const unsaved = element('progress-unsaved');
    unsaved.hidden = status.unsavedCount === 0;
    unsaved.textContent = `${plural(status.unsavedCount, 'result')} could not be saved. The computer's disk may be full. Press Stop if you would rather fix that first.`;

    const stop = element('progress-stop');
    stop.hidden = !running;
    stop.disabled = status.stopping;
    stop.textContent = status.stopping ? 'Stopping' : 'Stop';

    for (const id of ['download-results', 'undo-this', 'new-batch']) {
        element(id).hidden = running;
    }

    element('progress-summary').hidden = running;
    element('report-box').hidden = running || !status.report;
    element('download-errors').hidden = running || !status.hasErrors;
    element('resume-this').hidden = running || (status.result === 'finished' && status.failed === 0);

    if (!running) {
        const headline = { finished: 'Batch finished.', stopped: 'Batch stopped.', failed: 'Batch ended early.' }[status.result];

        element('progress-summary').textContent = `${headline} ${status.ok} worked, ${status.failed} did not.`;
        element('report-text').textContent = status.report ?? '';
        element('resume-this').textContent = status.result === 'finished' ? 'Try failed changes again' : 'Resume';
    }
}

async function followBatch() {
    show('progress');
    clearInterval(state.polling);

    const tick = async () => {
        const status = await api('/api/batch');
        renderBatch(status);

        if (status.state !== 'running') {
            clearInterval(state.polling);
        }
    };

    await tick();
    state.polling = setInterval(() => tick().catch((error) => notify(error.message)), 1000);
}

function renderHistory(batches) {
    const box = element('history-list');

    if (batches.length === 0) {
        box.textContent = 'No batches yet.';
        return;
    }

    box.replaceChildren(
        ...batches.map((item) => {
            const card = document.createElement('div');
            const title = document.createElement('h2');
            const info = document.createElement('p');
            const buttons = document.createElement('div');

            card.className = 'card stack';
            title.textContent = `${item.kind === 'undo' ? 'Undo batch' : 'Batch'} ${item.batch}`;
            info.textContent = `${new Date(item.createdAt).toLocaleString()}, ${item.status}, by ${item.operator}`;
            buttons.className = 'button-row';

            const add = (label, work) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'button';
                button.textContent = label;
                action(button, work);
                buttons.append(button);
            };

            if (item.hasResults) {
                add('Download results (CSV)', async () => save(`batch-${item.batch}-results.csv`, await api(`/api/batches/${item.batch}/results.csv`)));
                add('Undo', async () => renderPreview(await api('/api/undo-preview', { batch: item.batch })));
            }

            if (item.hasErrors) {
                add('Download errors (CSV)', async () => save(`batch-${item.batch}-errors.csv`, await api(`/api/batches/${item.batch}/errors.csv`)));
            }

            if (item.canResume) {
                add('Resume', async () => {
                    await api('/api/resume', { batch: item.batch });
                    await followBatch();
                });
            }

            card.append(title, info, buttons);
            return card;
        }),
    );
}

async function openBuild() {
    state.settings = await api('/api/state');

    if (!state.settings.configured) {
        openSetup();
        return;
    }

    if (state.settings.connectionError) {
        notify(state.settings.connectionError);
        openSetup();
        return;
    }

    element('server-name').textContent = state.settings.serverName;
    state.members = await api('/api/members');
    renderRoles();
    show('members');
}

const needsCommandRole = () => (state.settings.assignable ?? []).length > 0 && !state.settings.commandRoleId;

function roleReminderSkipped() {
    try {
        return localStorage.getItem(SKIP_ROLE_KEY) === 'yes';
    } catch {
        return false;
    }
}

function skipRoleReminder() {
    try {
        localStorage.setItem(SKIP_ROLE_KEY, 'yes');
    } catch {
        // Only a convenience, so the reminder just shows again next time.
    }
}

function askForRole() {
    notify('Nobody can use /rolebatch in Discord yet. Choose which role can use it, or carry on with only this panel. You can change this any time in Settings.', {
        kind: 'info',
        actions: [
            {
                label: 'Choose a role',
                run: () => {
                    openSetup();
                    element('setup-role').focus();
                },
            },
            {
                label: 'Continue without a role',
                run: () => {
                    skipRoleReminder();
                    openBuild().catch((error) => notify(error.message));
                },
            },
        ],
    });
}

function renderRoleChoice() {
    const { assignable = [], commandRoleId = '' } = state.settings;
    const none = document.createElement('option');

    none.value = '';
    none.textContent = 'Nobody yet';
    element('setup-role-field').hidden = assignable.length === 0;
    element('setup-role').replaceChildren(
        none,
        ...assignable.map(({ id, name }) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = name;
            return option;
        }),
    );
    element('setup-role').value = commandRoleId;
}

function renderUpdates() {
    const { version, enabled, available, previous } = state.update;

    element('update-card').hidden = !enabled;
    element('update-version').textContent = available ? `You have version ${version}. Version ${available.version} is ready.` : `You have version ${version}, the newest one.`;
    element('update-install').hidden = !available;
    element('update-rollback').hidden = !previous;
}

// Closing the app's window can't reach the browser by itself, so the page keeps checking in.
// When the app comes back it has a new session, so the page reloads.
function watchConnection() {
    let lost = false;

    setInterval(async () => {
        if (state.restarting) {
            return;
        }

        try {
            await fetch('/api/update', { headers: { 'X-Zombi-Session': session } });

            if (lost) {
                location.reload();
            }
        } catch {
            if (!lost) {
                lost = true;
                notify('Connection lost. Zombi Roles has stopped, so nothing can run from here or from Discord.', {
                    sticky: true,
                    details: ['Double-click Zombi Roles Launcher to continue. This page will reconnect by itself.', ...(state.batch?.state === 'running' ? ['A batch was running. You can resume it from Past batches.'] : [])],
                });
            }
        }
    }, CONNECTION_CHECK_MS);
}

async function shutDown() {
    await api('/api/shutdown', {});
    state.restarting = true;
    notify('Zombi Roles has shut down. You can close this tab.', { kind: 'info', sticky: true });
}

async function waitForRestart() {
    state.restarting = true;
    notify('Restarting. This page will reload in a moment.', { kind: 'info' });

    for (;;) {
        await new Promise((done) => setTimeout(done, 1000));

        try {
            if ((await fetch('/')).ok) {
                location.reload();
                return;
            }
        } catch {
            // Still restarting.
        }
    }
}

async function installUpdate() {
    await api('/api/update/install', {});
    await waitForRestart();
}

function offerUpdate() {
    const { available } = state.update;

    if (available) {
        notify(`Version ${available.version} is ready to install.`, {
            kind: 'info',
            details: available.notes ? [available.notes] : [],
            action: { label: 'Update now', run: () => installUpdate().catch((error) => notify(error.message)) },
        });
    }
}

function openSetup() {
    const { hasToken, tokenEnding, serverId, operatorName, retentionDays } = state.settings;

    element('setup-token').value = '';
    element('setup-token').required = !hasToken;
    element('setup-token-hint').textContent = hasToken
        ? `A token ending in ${tokenEnding} is saved. Leave this empty to keep it.`
        : 'From the Bot page in the Discord Developer Portal.';
    element('setup-server').value = serverId;
    element('setup-name').value = operatorName;
    element('setup-retention').value = retentionDays;
    renderRoleChoice();
    renderUpdates();
    show('setup');
}

const usingNames = () => document.querySelector('input[name="mode"]:checked').value === 'names';

function goToRoles(who) {
    state.who = who;
    element('roles-summary').textContent = `For ${plural(who.memberIds.length, 'member')}.`;
    show('roles');
}

function nameProblems({ unresolved, suggestions, ambiguous }) {
    return [
        ...unresolved.map((name) => {
            const suggestion = suggestions[name];
            return suggestion ? `${name}: no match. Did you mean ${suggestion}?` : `${name}: no member has this name. Check the spelling.`;
        }),
        ...ambiguous.map(({ name, candidates }) => `${name}: ${plural(candidates.length, 'member')} share this name (${candidates.join(', ')}). Use the username instead.`),
    ];
}

async function checkNames() {
    const file = element('names-file').files[0];
    const result = await api('/api/match', {
        text: element('names-text').value,
        fileText: file ? await file.text() : '',
        fileFormat: file?.name.toLowerCase().endsWith('.csv') ? 'csv' : 'lines',
    });
    const who = { memberIds: result.ids, unresolved: result.unresolved, ambiguous: result.ambiguous };
    const problems = nameProblems(result);

    if (problems.length === 0 && result.ids.length > 0) {
        goToRoles(who);
        return;
    }

    if (result.ids.length === 0 && problems.length === 0) {
        throw new Error('Enter at least one name, or add a file.');
    }

    notify(`${plural(result.ids.length, 'name')} matched and ${problems.length} need${problems.length === 1 ? 's' : ''} fixing.`, {
        kind: 'warning',
        details: problems,
        action: result.ids.length > 0 ? { label: `Continue with the ${plural(result.ids.length, 'matched name')}`, run: () => goToRoles(who) } : undefined,
    });
}

function wireEvents() {
    for (const button of document.querySelectorAll('[data-nav]')) {
        action(button, async () => {
            if (state.batch?.state === 'running') {
                await followBatch();
            } else if (button.dataset.nav === 'build') {
                await openBuild();
            } else if (button.dataset.nav === 'history') {
                renderHistory(await api('/api/batches'));
                show('history');
            } else {
                state.settings = await api('/api/state');
                openSetup();
            }
        });
    }

    element('setup-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        clearNotices();

        try {
            const { warning } = await api('/api/setup', {
                token: element('setup-token').value,
                serverId: element('setup-server').value,
                operatorName: element('setup-name').value,
                retentionDays: element('setup-retention').value,
                ...(!element('setup-role-field').hidden && { commandRoleId: element('setup-role').value }),
            });

            element('setup-token').value = '';

            if (warning) {
                notify(warning);
                return;
            }

            state.settings = await api('/api/state');

            if (needsCommandRole() && !state.askedForRole) {
                state.askedForRole = true;
                openSetup();
                askForRole();
                return;
            }

            await openBuild();
            notify('Settings saved.', { kind: 'success' });
        } catch (error) {
            notify(error.message);
        }
    });

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
        radio.addEventListener('change', () => {
            element('mode-pick').hidden = usingNames();
            element('mode-names').hidden = !usingNames();
            element('pick-footer').hidden = usingNames();
            element('members-next').textContent = usingNames() ? 'Check names' : 'Next step';
            renderMembers();
        });
    }

    element('filter-search').addEventListener('input', ({ target }) => {
        state.search = target.value;
        state.page = 0;
        renderMembers();
    });

    action(element('filter-apply'), async () => {
        const invite = element('filter-invite').value.trim();

        if (!invite) {
            throw new Error('Enter an invite code or link first.');
        }

        const { ids, inviteWarning } = await api('/api/filter', { invite });
        state.filteredIds = ids;
        state.page = 0;
        element('filter-clear').hidden = ids === null;
        renderMembers();

        if (inviteWarning) {
            notify(inviteWarning, { kind: 'warning' });
        }
    });

    action(element('filter-clear'), async () => {
        element('filter-invite').value = '';
        element('filter-clear').hidden = true;
        state.filteredIds = null;
        state.page = 0;
        renderMembers();
    });

    element('select-all').addEventListener('click', () => {
        visibleMembers().forEach(({ id }) => state.selected.add(id));
        renderMembers();
    });

    element('select-none').addEventListener('click', () => {
        state.selected.clear();
        renderMembers();
    });

    element('page-previous').addEventListener('click', () => {
        state.page--;
        renderMembers();
    });

    element('page-next').addEventListener('click', () => {
        state.page++;
        renderMembers();
    });

    element('per-page').addEventListener('change', ({ target }) => {
        state.perPage = target.value;
        state.page = 0;
        savePerPage(target.value);
        renderMembers();
    });

    action(element('members-next'), async () => {
        if (usingNames()) {
            await checkNames();
            return;
        }

        if (state.selected.size === 0) {
            throw new Error('Choose at least one member.');
        }

        goToRoles({ memberIds: [...state.selected] });
    });

    action(element('roles-back'), async () => show('members'));

    action(element('make-preview'), async () => {
        const addRoleIds = checkedRoles('add');
        const removeRoleIds = checkedRoles('remove');

        if (addRoleIds.length === 0 && removeRoleIds.length === 0) {
            throw new Error('Choose at least one role to add or remove.');
        }

        renderPreview(await api('/api/preview', { ...state.who, addRoleIds, removeRoleIds }));
    });

    action(element('preview-back'), async () => {
        if (state.preview.kind === 'undo') {
            renderHistory(await api('/api/batches'));
            show('history');
        } else {
            show('roles');
        }
    });

    action(element('preview-confirm'), async () => {
        await api('/api/confirm', { previewId: state.preview.id });
        await followBatch();
    });

    action(element('progress-stop'), () => api('/api/stop', {}));

    action(element('download-errors'), async () => {
        const { batch } = state.batch;
        save(`batch-${batch}-errors.csv`, await api(`/api/batches/${batch}/errors.csv`));
    });

    action(element('download-results'), async () => {
        const { batch } = state.batch;
        save(`batch-${batch}-results.csv`, await api(`/api/batches/${batch}/results.csv`));
    });

    action(element('undo-this'), async () => renderPreview(await api('/api/undo-preview', { batch: state.batch.batch })));

    action(element('resume-this'), async () => {
        await api('/api/resume', { batch: state.batch.batch });
        await followBatch();
    });

    element('shut-down').addEventListener('click', () => {
        clearNotices();
        notify('Shut down Zombi Roles? The panel and /rolebatch stop until you double-click Zombi Roles Launcher again.', {
            kind: 'info',
            actions: [
                { label: 'Shut down', run: () => shutDown().catch((error) => notify(error.message)) },
                { label: 'Keep it running', run: () => {} },
            ],
        });
    });

    action(element('update-install'), installUpdate);

    action(element('update-rollback'), async () => {
        await api('/api/update/rollback', {});
        await waitForRestart();
    });

    action(element('new-batch'), async () => {
        state.selected.clear();
        state.who = null;
        element('names-text').value = '';
        element('names-file').value = '';
        await openBuild();
    });

    action(element('undo-file-button'), async () => {
        const file = element('undo-file').files[0];

        if (!file) {
            throw new Error('Choose a CSV file first.');
        }

        renderPreview(await api('/api/undo-preview', { csv: await file.text() }));
    });

    new ResizeObserver(() => {
        if (!element('view-members').hidden && state.perPage === 'fit' && fittedPageSize() !== state.pageSize) {
            renderMembers();
        }
    }).observe(element('table-wrap'));
}

wireEvents();
watchConnection();

state.perPage = loadPerPage();

if ([...element('per-page').options].some(({ value }) => value === state.perPage)) {
    element('per-page').value = state.perPage;
} else {
    state.perPage = 'fit';
}

try {
    const status = await api('/api/batch');
    state.update = await api('/api/update');

    if (status.state === 'running') {
        await followBatch();
    } else {
        await openBuild();
        offerUpdate();

        if (needsCommandRole() && !roleReminderSkipped()) {
            askForRole();
        }
    }
} catch (error) {
    notify(error.message);
}
