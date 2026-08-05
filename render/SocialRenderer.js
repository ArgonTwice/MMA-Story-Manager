/**
 * render/SocialRenderer.js
 * ---------------------------------------------------------------------------
 * The social media feed: fan reactions, journalist recaps, rival trash
 * talk and fighter statements, newest first. Every post — regardless of
 * whether SocialEngine, EventEngine, or anything else authored it — flows
 * through PlayerState.pushSocialFeedEntry(), which is the single source of
 * truth this renderer listens to (see state/PlayerState.js).
 * ---------------------------------------------------------------------------
 */

import { BaseRenderer } from './BaseRenderer.js';
import { PLAYER_EVENTS } from '../state/PlayerState.js';

/** Display-only concern (not gameplay balance): how many posts the feed shows. */
const FEED_DISPLAY_LIMIT = 30;

export class SocialRenderer extends BaseRenderer {
  /**
   * @param {Object} options
   * @param {Object} options.playerState - A PlayerState instance.
   * @param {Object} [options.mount]
   * @param {Function} [options.onRender]
   */
  constructor(options = {}) {
    super(options);
    this.playerState = options.playerState;
    this.viewModel = { feed: [] };
  }

  /** @returns {SocialRenderer} this, for chaining. */
  attach() {
    this._subscribe(PLAYER_EVENTS.SOCIAL_FEED_ENTRY_ADDED, () => this.render());
    this.render();
    return this;
  }

  /** Recomputes the visible feed from current state. */
  render() {
    this.viewModel = { feed: this._buildFeed() };
    return this._flush();
  }

  _buildFeed() {
    return [...this.playerState.socialFeed].reverse().slice(0, FEED_DISPLAY_LIMIT);
  }

  toHTML() {
    const postsHTML = this.viewModel.feed
      .map(
        (post) =>
          `<li class="social-post" data-author-type="${post.authorType}">` +
          `<div class="post-author">${post.author}</div>` +
          `<div class="post-text">${post.text}</div>` +
          `<div class="post-likes">&#9733; ${post.likes}</div>` +
          `</li>`
      )
      .join('');
    return `<section class="social-feed"><ul class="feed-list">${postsHTML}</ul></section>`;
  }
}

export default SocialRenderer;
