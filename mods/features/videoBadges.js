/**
 * Read badge signals from both classic tile renderers and newer lockup view
 * models. Badge containers are searched instead of all text so a video title
 * containing the words "members only" is not accidentally removed.
 */

const MAX_DEPTH = 10;
const MAX_TAKE_DEPTH = 6;
const MAX_BADGES = 12;
const BADGE_KEY = /badge/i;

const MEMBER_STYLES = ['MEMBERS_ONLY', 'SPONSORS_ONLY'];
const MEMBER_LABELS = [
    'members only', 'members-only',
    'kanalmitglieder', 'mitglieder',
    'solo para miembros', 'membres uniquement',
    'solo per gli iscritti', 'alleen voor leden',
];

export function badgeSignals(item) {
    const signals = [];
    const seen = new Set();

    const take = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > MAX_TAKE_DEPTH || signals.length >= MAX_BADGES) return;
        if (Array.isArray(node)) {
            for (const child of node) take(child, depth + 1);
            return;
        }

        const style = typeof node.style === 'string' ? node.style : '';
        const label = typeof node.label === 'string' ? node.label
            : node.text?.simpleText
            || (typeof node.text === 'string' ? node.text : '')
            || node.text?.content
            || (Array.isArray(node.text?.runs) ? node.text.runs.map(run => run?.text || '').join('') : '')
            || '';
        if (style || label) {
            const key = `${style}\u0000${label}`;
            if (!seen.has(key)) {
                seen.add(key);
                signals.push({ style: String(style), label: String(label) });
            }
        }
        for (const value of Object.values(node)) take(value, depth + 1);
    };

    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > MAX_DEPTH || signals.length >= MAX_BADGES) return;
        if (Array.isArray(node)) {
            for (const child of node) walk(child, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            // Long-press actions can contain a copy of the original tile.
            if (key === 'parameters') continue;
            if (BADGE_KEY.test(key)) take(node[key], 0);
            else walk(node[key], depth + 1);
        }
    };

    walk(item, 0);
    return signals;
}

// Membership badges that carry only an icon, or a style variant such as
// BADGE_STYLE_TYPE_MEMBERS_ONLY_LOCKED, rather than one of the labels above.
const MEMBER_ICONS = /MEMBER|SPONSORSHIP/;

function hasMemberIcon(item, depth = 0) {
    if (!item || typeof item !== 'object' || depth > MAX_DEPTH) return false;
    for (const [key, value] of Object.entries(item)) {
        if (key === 'parameters') continue;
        if (BADGE_KEY.test(key) || /overlay/i.test(key)) {
            if (JSON.stringify(value).match(/"(?:iconType|style|badgeStyle)":"([^"]+)"/g)?.some(match => MEMBER_ICONS.test(match.toUpperCase()))) return true;
        } else if (hasMemberIcon(value, depth + 1)) return true;
    }
    return false;
}

export function isMembersOnlyVideo(item) {
    if (hasMemberIcon(item)) return true;
    return badgeSignals(item).some(({ style, label }) => {
        const normalizedStyle = style.toUpperCase();
        if (MEMBER_STYLES.some(hint => normalizedStyle.includes(hint))) return true;
        const normalizedLabel = label.toLowerCase();
        return MEMBER_LABELS.some(hint => normalizedLabel.includes(hint));
    });
}
