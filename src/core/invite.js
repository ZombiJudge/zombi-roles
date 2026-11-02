const INVITE_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([^/?#\s]+)\/?(?:[?#].*)?$/i;

// Takes an invite code or a full invite link and returns just the code.
export function parseInviteCode(text) {
    const trimmed = text.trim();
    const code = INVITE_LINK.exec(trimmed)?.[1] ?? trimmed;

    if (!/^[A-Za-z0-9-]+$/.test(code)) {
        throw new RangeError('That does not look like an invite code or link. Try something like discord.gg/abc123.');
    }

    return code;
}
