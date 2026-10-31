import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.window = { localStorage: store, location: { hash: '#/' }, dispatchEvent() {} };
globalThis.CustomEvent = class {
    constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
    }
};

const { configRead, configWrite } = await import('../config.js');
const { isMembersOnlyVideo } = await import('../features/videoBadges.js');
const { filterMembersOnlyVideos } = await import('../features/membersOnlyHider.js');
const { stopForcedSubtitles } = await import('../features/forcedSubtitleStopper.js');
const {
    addDislikes,
    findVideoId,
    formatDislikeCount,
    injectDislikes,
    requestVotes,
} = await import('../features/returnYoutubeDislike.js');

beforeEach(() => {
    delete window.h5vcc;
    configWrite('hideMembersOnlyVideos', false);
    configWrite('enableStopForcedSubtitles', false);
    configWrite('enableReturnYoutubeDislike', false);
});

test('Android uses the scoped native bridge and opt-out prevents bridge requests', async () => {
    window.h5vcc = { tizentube: {} };
    let requests = [];
    globalThis.fetch = async url => {
        requests.push(url);
        return { ok: true, json: async () => ({ dislikes: 17 }) };
    };
    assert.equal(await requestVotes('abcdefghijk'), null);
    assert.deepEqual(requests, []);
    configWrite('enableReturnYoutubeDislike', true);
    assert.equal((await requestVotes('abcdefghijk')).dislikes, 17);
    assert.deepEqual(requests, ['http://127.0.0.1:18945/votes?videoId=abcdefghijk']);
    configWrite('enableReturnYoutubeDislike', false);
    assert.equal(await requestVotes('abcdefghijk'), null);
    assert.equal(requests.length, 1);
});

test('privacy-sensitive and filtering features default to off', () => {
    assert.equal(configRead('hideMembersOnlyVideos'), false);
    assert.equal(configRead('enableStopForcedSubtitles'), false);
    assert.equal(configRead('enableReturnYoutubeDislike'), false);
});

test('members-only badges are detected without matching ordinary titles', () => {
    const members = {
        lockupViewModel: {
            metadata: {
                thumbnailBadgeViewModel: {
                    badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } },
                },
            },
        },
    };
    const ordinary = {
        tileRenderer: {
            metadata: { tileMetadataRenderer: { title: { simpleText: 'Why members only clubs exist' } } },
        },
    };
    assert.equal(isMembersOnlyVideo(members), true);
    assert.equal(isMembersOnlyVideo(ordinary), false);
});

test('members-only videos are removed only when the option is enabled', () => {
    const members = { tileRenderer: { badges: [{ metadataBadgeRenderer: { label: 'Members only' } }] } };
    const publicVideo = { tileRenderer: { contentId: 'public' } };
    assert.equal(filterMembersOnlyVideos([members, publicVideo]).length, 2);
    configWrite('hideMembersOnlyVideos', true);
    assert.deepEqual(filterMembersOnlyVideos([members, publicVideo]), [publicVideo]);
});

test('forced-caption instructions are removed but caption tracks remain', () => {
    const response = {
        captions: {
            playerCaptionsTracklistRenderer: {
                captionTracks: [{ baseUrl: 'manual-track' }],
                audioTracks: [{ captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_REQUIRED', hasDefaultTrack: true }],
            },
        },
    };
    stopForcedSubtitles(response);
    assert.equal(response.captions.playerCaptionsTracklistRenderer.audioTracks[0].hasDefaultTrack, true);
    configWrite('enableStopForcedSubtitles', true);
    stopForcedSubtitles(response);
    const track = response.captions.playerCaptionsTracklistRenderer.audioTracks[0];
    assert.equal('captionsInitialState' in track, false);
    assert.equal(track.hasDefaultTrack, false);
    assert.equal(response.captions.playerCaptionsTracklistRenderer.captionTracks.length, 1);
});

test('dislikes are written beside the button and into the description panel', () => {
    const renderer = {};
    const factoid = [];
    const response = {
        videoDetails: { videoId: 'abc' },
        transportControls: {
            transportControlsRenderer: {
                buttons: [{
                    type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_LIKE_BUTTON',
                    button: { likeButtonRenderer: renderer },
                }],
            },
        },
        engagementPanels: [{
            engagementPanelSectionListRenderer: {
                panelIdentifier: 'video-description-ep-identifier',
                content: {
                    structuredDescriptionContentRenderer: {
                        items: [{ videoDescriptionHeaderRenderer: { factoid } }],
                    },
                },
            },
        }],
    };
    injectDislikes(response, { dislikes: 12500 });
    assert.equal(renderer.dislikeCountText.simpleText, '12.5K');
    assert.equal(factoid[0].factoidRenderer.value.simpleText, '12.5K');
    assert.equal(factoid[0].factoidRenderer.label.simpleText, 'Dislikes');
    assert.equal(findVideoId(response), 'abc');
    assert.equal(formatDislikeCount(2000000), '2M');
});

test('Return YouTube Dislike makes no request while disabled', () => {
    globalThis.fetch = () => { throw new Error('fetch must not run'); };
    const response = { videoDetails: { videoId: 'private-id' } };
    assert.equal(addDislikes(response), response);
});

test('Return YouTube Dislike sends the enabled video ID once and reuses the result', async () => {
    let requestedUrl = '';
    let requests = 0;
    globalThis.fetch = async url => {
        requests++;
        requestedUrl = url;
        return { ok: true, json: async () => ({ dislikes: 42 }) };
    };
    configWrite('enableReturnYoutubeDislike', true);
    await requestVotes('service-video-id');

    const renderer = {};
    addDislikes({
        videoDetails: { videoId: 'service-video-id' },
        transportControls: {
            transportControlsRenderer: {
                buttons: [{ button: { likeButtonRenderer: renderer } }],
            },
        },
    });
    assert.match(requestedUrl, /videoId=service-video-id$/);
    assert.equal(requests, 1);
    assert.equal(renderer.dislikeCountText.simpleText, '42');
});

test('members-only badges that carry only an icon or a style variant are recognised', () => {
    const iconOnly = { tileRenderer: { header: { tileHeaderRenderer: { thumbnailOverlays: [
        { thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { icon: { sources: [{ clientResource: { imageName: 'x' } }] }, iconType: 'BADGE_MEMBERSHIP' } }] } },
    ] } } } };
    const styleVariant = { tileRenderer: { metadata: { tileMetadataRenderer: { lines: [{ lineRenderer: { items: [
        { lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY_LOCKED' } } } },
    ] } }] } } } };
    const normal = { tileRenderer: { header: { tileHeaderRenderer: { thumbnailOverlays: [
        { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '12:34' }, style: 'DEFAULT' } },
    ] } }, metadata: { tileMetadataRenderer: { title: { simpleText: 'How members of the club...' } } } } };
    assert.equal(isMembersOnlyVideo(iconOnly), true);
    assert.equal(isMembersOnlyVideo(styleVariant), true);
    assert.equal(isMembersOnlyVideo(normal), false);
});
