import { describe, expect, it } from 'vitest';
import { isMatrixMention } from './matrix.js';

describe('isMatrixMention', () => {
  const botUserId = '@router:mtrx.shaperotator.xyz';
  const botHandle = 'router';

  it('treats DMs as mentions', () => {
    expect(
      isMatrixMention({
        isDM: true,
        text: 'hello',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects structured Matrix mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'hey router',
        content: {
          'm.mentions': {
            user_ids: [botUserId],
          },
        },
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects formatted-body Matrix mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'hey router',
        content: {
          formatted_body: '<a href="https://matrix.to/#/%40router%3Amtrx.shaperotator.xyz">router</a>',
        },
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects plain-text @mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: '@router can you weigh in?',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('ignores ordinary messages without a mention', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'does anyone have thoughts?',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(false);
  });
});
