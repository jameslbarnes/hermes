import { describe, expect, it, vi } from 'vitest';
import { MatrixPlatform, isMatrixMention } from './matrix.js';

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

describe('MatrixPlatform identity resolution', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('resolves linked Matrix user IDs before falling back to the local convention', async () => {
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) =>
        name === 'matrix' && handle === 'james' ? '@specularist:matrix.org' : null,
    });

    await expect(platform.resolvePlatformId('james')).resolves.toBe('@specularist:matrix.org');
    await expect(platform.resolvePlatformId('alice')).resolves.toBe('@alice:mtrx.example.test');
  });

  it('resolves Hermes handles from linked Matrix accounts before parsing MXIDs', async () => {
    const platform = createPlatform({
      resolveLinkedHermesHandle: async (name, userId) =>
        name === 'matrix' && userId === '@specularist:matrix.org' ? 'james' : null,
    });

    await expect(platform.resolveHermesHandle('@specularist:matrix.org')).resolves.toBe('james');
    await expect(platform.resolveHermesHandle('@alice:mtrx.example.test')).resolves.toBe('alice');
  });
});

describe('MatrixPlatform channel rooms', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('publishes existing alias-backed rooms to the Matrix room directory', async () => {
    const getRoomIdForAlias = vi.fn().mockResolvedValue({ room_id: '!books:mtrx.example.test' });
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const platform = createPlatform();

    (platform as any).client = {
      getRoomIdForAlias,
      setRoomDirectoryVisibility,
    };

    await expect(platform.ensureChannelRoom('books', 'Books')).resolves.toBe('!books:mtrx.example.test');
    expect(getRoomIdForAlias).toHaveBeenCalledWith('#books:mtrx.example.test');
    expect(setRoomDirectoryVisibility).toHaveBeenCalledWith('!books:mtrx.example.test', 'public');
  });

  it('attaches existing alias-backed rooms to the configured Matrix space', async () => {
    const getRoomIdForAlias = vi.fn().mockResolvedValue({ room_id: '!books:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getRoomIdForAlias,
      joinRoom,
      setRoomDirectoryVisibility,
      sendStateEvent,
    };

    await expect(platform.ensureChannelRoom('books', 'Books')).resolves.toBe('!books:mtrx.example.test');
    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      1,
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!books:mtrx.example.test',
    );
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      2,
      '!books:mtrx.example.test',
      'm.space.parent',
      { via: ['mtrx.example.test'], canonical: true },
      '!space:mtrx.example.test',
    );
  });

  it('creates new rooms as public and publishes them to the Matrix room directory', async () => {
    const getRoomIdForAlias = vi.fn().mockRejectedValue(new Error('not found'));
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!books-created:mtrx.example.test' });
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const platform = createPlatform();

    (platform as any).client = {
      getRoomIdForAlias,
      createRoom,
      setRoomDirectoryVisibility,
    };

    await expect(platform.ensureChannelRoom('books', 'Books', 'Book discussion')).resolves.toBe('!books-created:mtrx.example.test');
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Books',
      topic: 'Book discussion',
      room_alias_name: 'books',
      visibility: 'public',
      preset: 'public_chat',
    }));
    expect(setRoomDirectoryVisibility).toHaveBeenCalledWith('!books-created:mtrx.example.test', 'public');
  });

  it('attaches newly created rooms to the configured Matrix space', async () => {
    const getRoomIdForAlias = vi.fn().mockRejectedValue(new Error('not found'));
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!books-created:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getRoomIdForAlias,
      createRoom,
      joinRoom,
      setRoomDirectoryVisibility,
      sendStateEvent,
    };

    await expect(platform.ensureChannelRoom('books', 'Books', 'Book discussion')).resolves.toBe('!books-created:mtrx.example.test');
    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      1,
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!books-created:mtrx.example.test',
    );
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      2,
      '!books-created:mtrx.example.test',
      'm.space.parent',
      { via: ['mtrx.example.test'], canonical: true },
      '!space:mtrx.example.test',
    );
  });
});

describe('MatrixPlatform post rendering', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    baseUrl: 'https://hermes.example.test',
    ...overrides,
  });

  it('renders linked Matrix IDs for authors and inline handles in Matrix posts', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) => {
        if (name !== 'matrix') return null;
        if (handle === 'james') return '@specularist:matrix.org';
        if (handle === 'socrates1024') return '@socrates1024:matrix.org';
        return null;
      },
    });

    (platform as any).client = { sendMessage };

    await expect(platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-1',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: 'Looping in @socrates1024 on this one.',
      timestamp: Date.now(),
    })).resolves.toBe('$event');

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      author_handle: 'james',
      author_platform_id: '@specularist:matrix.org',
      body: expect.stringContaining('@specularist:matrix.org: Looping in @socrates1024:matrix.org on this one.'),
      formatted_body: expect.stringContaining('https://matrix.to/#/%40specularist%3Amatrix.org'),
    }));
    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('https://matrix.to/#/%40socrates1024%3Amatrix.org'),
    }));
  });

  it('leaves Hermes handles untouched when no linked Matrix ID exists', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async () => null,
    });

    (platform as any).client = { sendMessage };

    await platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-2',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: 'Asking @someone-else to weigh in.',
      timestamp: Date.now(),
    });

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      author_platform_id: undefined,
      body: expect.stringContaining('@james: Asking @someone-else to weigh in.'),
      formatted_body: expect.stringContaining('@james'),
    }));
  });
});
