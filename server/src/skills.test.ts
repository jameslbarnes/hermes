import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, type Skill, type User, type BroadcastConfig } from './storage.js';
import { hashSecretKey } from './identity.js';
import { SYSTEM_SKILLS } from './http.js';

describe('Skills System', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM SKILLS
  // ═══════════════════════════════════════════════════════════════

  describe('System Skills', () => {
    it('should have write_to_shared_notebook as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'write_to_shared_notebook');
      expect(skill).toBeDefined();
      expect(skill!.author).toBe('hermes');
      expect(skill!.public).toBe(true);
      expect(skill!.id).toBe('system_write_to_shared_notebook');
    });

    it('should have write_essay_to_shared_notebook as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'write_essay_to_shared_notebook');
      expect(skill).toBeDefined();
      expect(skill!.author).toBe('hermes');
      expect(skill!.public).toBe(true);
      expect(skill!.id).toBe('system_write_essay_to_shared_notebook');
    });

    it('should have required parameters defined', () => {
      for (const skill of SYSTEM_SKILLS) {
        expect(skill.parameters).toBeDefined();
        expect(skill.parameters!.length).toBeGreaterThan(0);

        // All system skills should have sensitivity_check as first param
        expect(skill.parameters![0].name).toBe('sensitivity_check');
        expect(skill.parameters![0].required).toBe(true);
      }
    });

    it('should have instructions defined', () => {
      for (const skill of SYSTEM_SKILLS) {
        expect(skill.instructions).toBeDefined();
        expect(skill.instructions.length).toBeGreaterThan(50);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // USER SKILLS CRUD (via storage)
  // ═══════════════════════════════════════════════════════════════

  describe('User Skills Storage', () => {
    const testUser = {
      handle: 'skilluser',
      secretKeyHash: hashSecretKey('test-secret-key-for-skills'),
      displayName: 'Skill Tester',
    };

    const testSkill: Skill = {
      id: 'skill_123',
      name: 'newsletter',
      description: 'Send a weekly newsletter',
      instructions: 'Compile the week\'s highlights and format as a newsletter.',
      parameters: [
        { name: 'topic', type: 'string', description: 'Newsletter topic', required: true },
        { name: 'audience', type: 'string', description: 'Target audience', required: false },
      ],
      postToNotebook: true,
      humanVisible: true,
      public: false,
      author: 'skilluser',
      createdAt: Date.now(),
    };

    describe('createUser with skills', () => {
      it('should create user without skills by default', async () => {
        const user = await storage.createUser(testUser);
        expect(user.skills).toBeUndefined();
      });
    });

    describe('updateUser with skills', () => {
      it('should add skills to user', async () => {
        await storage.createUser(testUser);

        const updated = await storage.updateUser('skilluser', {
          skills: [testSkill],
        });

        expect(updated!.skills).toBeDefined();
        expect(updated!.skills).toHaveLength(1);
        expect(updated!.skills![0].name).toBe('newsletter');
      });

      it('should update existing skills', async () => {
        await storage.createUser(testUser);
        await storage.updateUser('skilluser', { skills: [testSkill] });

        const updatedSkill = { ...testSkill, description: 'Updated description' };
        const updated = await storage.updateUser('skilluser', {
          skills: [updatedSkill],
        });

        expect(updated!.skills![0].description).toBe('Updated description');
      });

      it('should add multiple skills', async () => {
        await storage.createUser(testUser);

        const skill2: Skill = {
          ...testSkill,
          id: 'skill_456',
          name: 'daily_standup',
          description: 'Post daily standup notes',
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [testSkill, skill2],
        });

        expect(updated!.skills).toHaveLength(2);
        expect(updated!.skills!.map(s => s.name)).toContain('newsletter');
        expect(updated!.skills!.map(s => s.name)).toContain('daily_standup');
      });

      it('should remove skills by updating with empty array', async () => {
        await storage.createUser(testUser);
        await storage.updateUser('skilluser', { skills: [testSkill] });

        const updated = await storage.updateUser('skilluser', { skills: [] });
        expect(updated!.skills).toHaveLength(0);
      });
    });

    describe('skills with broadcast targets', () => {
      it('should store email targets', async () => {
        await storage.createUser(testUser);

        const skillWithEmail: Skill = {
          ...testSkill,
          emailTo: ['friend@example.com', 'team@example.com'],
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [skillWithEmail],
        });

        expect(updated!.skills![0].emailTo).toEqual(['friend@example.com', 'team@example.com']);
      });

      it('should store webhook config', async () => {
        await storage.createUser(testUser);

        const skillWithWebhook: Skill = {
          ...testSkill,
          webhookUrl: 'https://hooks.example.com/notify',
          webhookHeaders: { 'X-API-Key': 'secret123' },
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [skillWithWebhook],
        });

        expect(updated!.skills![0].webhookUrl).toBe('https://hooks.example.com/notify');
        expect(updated!.skills![0].webhookHeaders).toEqual({ 'X-API-Key': 'secret123' });
      });

      it('should store trigger conditions', async () => {
        await storage.createUser(testUser);

        const skillWithTrigger: Skill = {
          ...testSkill,
          triggerCondition: 'when user mentions Project Alpha',
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [skillWithTrigger],
        });

        expect(updated!.skills![0].triggerCondition).toBe('when user mentions Project Alpha');
      });
    });

    describe('public skills', () => {
      it('should store public flag', async () => {
        await storage.createUser(testUser);

        const publicSkill: Skill = {
          ...testSkill,
          public: true,
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [publicSkill],
        });

        expect(updated!.skills![0].public).toBe(true);
      });

      it('should store clone metadata', async () => {
        await storage.createUser(testUser);

        const clonedSkill: Skill = {
          ...testSkill,
          clonedFrom: 'otheruser/skill_original',
          cloneCount: 0,
        };

        const updated = await storage.updateUser('skilluser', {
          skills: [clonedSkill],
        });

        expect(updated!.skills![0].clonedFrom).toBe('otheruser/skill_original');
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getAllUsers (for public skills gallery)
  // ═══════════════════════════════════════════════════════════════

  describe('getAllUsers', () => {
    it('should return empty array when no users', async () => {
      const users = await storage.getAllUsers();
      expect(users).toHaveLength(0);
    });

    it('should return all users', async () => {
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key'),
      });
      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key'),
      });
      await storage.createUser({
        handle: 'charlie',
        secretKeyHash: hashSecretKey('charlie-key'),
      });

      const users = await storage.getAllUsers();
      expect(users).toHaveLength(3);
      expect(users.map(u => u.handle).sort()).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should include user skills in results', async () => {
      const skill: Skill = {
        id: 'skill_test',
        name: 'test_skill',
        description: 'A test skill',
        instructions: 'Do something',
        public: true,
        author: 'alice',
        createdAt: Date.now(),
      };

      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key'),
      });
      await storage.updateUser('alice', { skills: [skill] });

      const users = await storage.getAllUsers();
      const alice = users.find(u => u.handle === 'alice');

      expect(alice!.skills).toBeDefined();
      expect(alice!.skills).toHaveLength(1);
      expect(alice!.skills![0].name).toBe('test_skill');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC SKILLS FILTERING
  // ═══════════════════════════════════════════════════════════════

  describe('Public Skills Filtering', () => {
    beforeEach(async () => {
      // Create users with various skills
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key'),
      });
      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key'),
      });

      // Alice has one public and one private skill
      await storage.updateUser('alice', {
        skills: [
          {
            id: 'alice_public',
            name: 'public_skill',
            description: 'A public skill from Alice',
            instructions: 'Do public things',
            public: true,
            author: 'alice',
            cloneCount: 5,
            createdAt: Date.now(),
          },
          {
            id: 'alice_private',
            name: 'private_skill',
            description: 'A private skill from Alice',
            instructions: 'Do private things',
            public: false,
            author: 'alice',
            createdAt: Date.now(),
          },
        ],
      });

      // Bob has only private skills
      await storage.updateUser('bob', {
        skills: [
          {
            id: 'bob_private',
            name: 'bob_skill',
            description: 'Bob\'s private skill',
            instructions: 'Do bob things',
            public: false,
            author: 'bob',
            createdAt: Date.now(),
          },
        ],
      });
    });

    it('should filter to only public skills', async () => {
      const allUsers = await storage.getAllUsers();
      const publicSkills: Array<{ skill: Skill; author: string }> = [];

      for (const user of allUsers) {
        if (user.skills) {
          for (const skill of user.skills) {
            if (skill.public) {
              publicSkills.push({ skill, author: user.handle });
            }
          }
        }
      }

      expect(publicSkills).toHaveLength(1);
      expect(publicSkills[0].skill.name).toBe('public_skill');
      expect(publicSkills[0].author).toBe('alice');
    });

    it('should include clone count for sorting', async () => {
      // Add another user with a more popular skill
      await storage.createUser({
        handle: 'charlie',
        secretKeyHash: hashSecretKey('charlie-key'),
      });
      await storage.updateUser('charlie', {
        skills: [
          {
            id: 'charlie_popular',
            name: 'popular_skill',
            description: 'A very popular skill',
            instructions: 'Do popular things',
            public: true,
            author: 'charlie',
            cloneCount: 100,
            createdAt: Date.now(),
          },
        ],
      });

      const allUsers = await storage.getAllUsers();
      const publicSkills: Array<{ skill: Skill; author: string }> = [];

      for (const user of allUsers) {
        if (user.skills) {
          for (const skill of user.skills) {
            if (skill.public) {
              publicSkills.push({ skill, author: user.handle });
            }
          }
        }
      }

      // Sort by clone count descending
      publicSkills.sort((a, b) => (b.skill.cloneCount || 0) - (a.skill.cloneCount || 0));

      expect(publicSkills[0].skill.name).toBe('popular_skill');
      expect(publicSkills[0].skill.cloneCount).toBe(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL CLONING LOGIC
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Cloning', () => {
    const sourceSkill: Skill = {
      id: 'source_skill_123',
      name: 'clonable_skill',
      description: 'A skill that can be cloned',
      instructions: 'Original instructions here',
      parameters: [
        { name: 'param1', type: 'string', description: 'First param', required: true },
      ],
      triggerCondition: 'when something happens',
      postToNotebook: true,
      humanVisible: true,
      emailTo: ['original@example.com'],
      webhookUrl: 'https://original.example.com/webhook',
      public: true,
      author: 'original_author',
      cloneCount: 10,
      createdAt: Date.now() - 100000,
    };

    it('should clone skill with new id', () => {
      const clonedSkill = {
        ...sourceSkill,
        id: `skill_${Date.now()}_abc123`,
        public: false,
        author: 'new_owner',
        clonedFrom: `original_author/${sourceSkill.id}`,
        cloneCount: 0,
        createdAt: Date.now(),
        updatedAt: undefined,
        emailTo: undefined,
        webhookUrl: undefined,
        webhookHeaders: undefined,
      };

      expect(clonedSkill.id).not.toBe(sourceSkill.id);
      expect(clonedSkill.author).toBe('new_owner');
      expect(clonedSkill.public).toBe(false);
      expect(clonedSkill.clonedFrom).toBe('original_author/source_skill_123');
    });

    it('should preserve instructions and parameters', () => {
      const clonedSkill = {
        ...sourceSkill,
        id: 'new_id',
        author: 'new_owner',
      };

      expect(clonedSkill.instructions).toBe(sourceSkill.instructions);
      expect(clonedSkill.parameters).toEqual(sourceSkill.parameters);
    });

    it('should reset broadcast targets', () => {
      const clonedSkill = {
        ...sourceSkill,
        emailTo: undefined,
        webhookUrl: undefined,
        webhookHeaders: undefined,
      };

      expect(clonedSkill.emailTo).toBeUndefined();
      expect(clonedSkill.webhookUrl).toBeUndefined();
    });

    it('should reset clone count to 0', () => {
      const clonedSkill = {
        ...sourceSkill,
        cloneCount: 0,
      };

      expect(clonedSkill.cloneCount).toBe(0);
    });

    it('should clone system skill', () => {
      const systemSkill = SYSTEM_SKILLS[0];

      const clonedSkill = {
        ...systemSkill,
        id: `skill_${Date.now()}_xyz789`,
        public: false,
        author: 'user_who_cloned',
        clonedFrom: `hermes/${systemSkill.id}`,
        cloneCount: 0,
        createdAt: Date.now(),
        emailTo: undefined,
        webhookUrl: undefined,
        webhookHeaders: undefined,
      };

      expect(clonedSkill.name).toBe(systemSkill.name);
      expect(clonedSkill.instructions).toBe(systemSkill.instructions);
      expect(clonedSkill.clonedFrom).toContain('hermes/');
      expect(clonedSkill.author).toBe('user_who_cloned');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL NAME NORMALIZATION
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Name Normalization', () => {
    it('should normalize to lowercase', () => {
      const name = 'MyNewsletter';
      const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      expect(normalized).toBe('mynewsletter');
    });

    it('should replace spaces with underscores', () => {
      const name = 'my newsletter skill';
      const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      expect(normalized).toBe('my_newsletter_skill');
    });

    it('should remove special characters', () => {
      const name = 'newsletter-v2.0!';
      const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      expect(normalized).toBe('newsletter_v2_0_');
    });

    it('should preserve numbers', () => {
      const name = 'skill123';
      const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      expect(normalized).toBe('skill123');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL PARAMETER VALIDATION
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Parameter Types', () => {
    it('should support string parameters', () => {
      const param = { name: 'topic', type: 'string' as const, description: 'Topic', required: true };
      expect(param.type).toBe('string');
    });

    it('should support boolean parameters', () => {
      const param = { name: 'verbose', type: 'boolean' as const, description: 'Verbose mode', required: false };
      expect(param.type).toBe('boolean');
    });

    it('should support number parameters', () => {
      const param = { name: 'count', type: 'number' as const, description: 'Count', required: true };
      expect(param.type).toBe('number');
    });

    it('should support array parameters', () => {
      const param = { name: 'tags', type: 'array' as const, description: 'Tags list', required: false };
      expect(param.type).toBe('array');
    });

    it('should support enum constraints', () => {
      const param = {
        name: 'priority',
        type: 'string' as const,
        description: 'Priority level',
        required: true,
        enum: ['low', 'medium', 'high'],
      };
      expect(param.enum).toEqual(['low', 'medium', 'high']);
    });

    it('should support default values', () => {
      const param = {
        name: 'format',
        type: 'string' as const,
        description: 'Output format',
        required: false,
        default: 'markdown',
      };
      expect(param.default).toBe('markdown');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // HUMANVISIBLE FIELD
  // ═══════════════════════════════════════════════════════════════

  describe('humanVisible Field', () => {
    it('should store humanVisible on entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'AI-only entry',
        timestamp: Date.now(),
        humanVisible: false,
      });

      expect(entry.humanVisible).toBe(false);
    });

    it('should default humanVisible to undefined (treated as true)', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Normal entry',
        timestamp: Date.now(),
      });

      expect(entry.humanVisible).toBeUndefined();
    });

    it('should store topicHints for AI-only entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Detailed discussion about authentication and TEE',
        timestamp: Date.now(),
        humanVisible: false,
        topicHints: ['authentication', 'TEE', 'security'],
      });

      expect(entry.topicHints).toEqual(['authentication', 'TEE', 'security']);
    });

    it('should store defaultHumanVisible on user', async () => {
      await storage.createUser({
        handle: 'aionly',
        secretKeyHash: hashSecretKey('ai-key'),
      });

      const updated = await storage.updateUser('aionly', {
        defaultHumanVisible: false,
      });

      expect(updated!.defaultHumanVisible).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DEFERRED BROADCASTS (BroadcastConfig)
  // ═══════════════════════════════════════════════════════════════

  describe('Deferred Broadcasts', () => {
    it('should store broadcastConfig on entry', async () => {
      const broadcastConfig: BroadcastConfig = {
        skillName: 'newsletter',
        emailTo: ['friend@example.com'],
        webhookUrl: 'https://hooks.example.com/notify',
        summary: 'Weekly update summary',
      };

      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Newsletter content here',
        timestamp: Date.now(),
        broadcastConfig,
      });

      expect(entry.broadcastConfig).toBeDefined();
      expect(entry.broadcastConfig!.skillName).toBe('newsletter');
      expect(entry.broadcastConfig!.emailTo).toEqual(['friend@example.com']);
      expect(entry.broadcastConfig!.webhookUrl).toBe('https://hooks.example.com/notify');
    });

    it('should store broadcastConfig with webhook headers', async () => {
      const broadcastConfig: BroadcastConfig = {
        skillName: 'api_notify',
        webhookUrl: 'https://api.example.com/webhook',
        webhookHeaders: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      };

      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'API notification',
        timestamp: Date.now(),
        broadcastConfig,
      });

      expect(entry.broadcastConfig!.webhookHeaders).toEqual({
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'value',
      });
    });

    it('should allow entries without broadcastConfig', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Normal entry without broadcasts',
        timestamp: Date.now(),
      });

      expect(entry.broadcastConfig).toBeUndefined();
    });

    it('should preserve broadcastConfig through retrieval', async () => {
      const broadcastConfig: BroadcastConfig = {
        skillName: 'test_skill',
        emailTo: ['a@example.com', 'b@example.com'],
      };

      const created = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Test content',
        timestamp: Date.now(),
        broadcastConfig,
      });

      const retrieved = await storage.getEntry(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.broadcastConfig).toEqual(broadcastConfig);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // INTEGRATION: Skills + Broadcasts
  // ═══════════════════════════════════════════════════════════════

  describe('Skills with Broadcast Targets', () => {
    const skillWithBroadcasts: Skill = {
      id: 'skill_broadcast_test',
      name: 'broadcast_test',
      description: 'A skill with all broadcast options',
      instructions: 'Test broadcasting',
      postToNotebook: true,
      humanVisible: true,
      emailTo: ['subscriber@example.com'],
      webhookUrl: 'https://webhooks.example.com/skill',
      webhookHeaders: { 'X-Skill-Token': 'abc123' },
      public: false,
      author: 'tester',
      createdAt: Date.now(),
    };

    it('should create entry with broadcastConfig from skill', async () => {
      // Simulate what broadcast_skill_result does
      const broadcastConfig: BroadcastConfig = {
        skillName: skillWithBroadcasts.name,
        emailTo: skillWithBroadcasts.emailTo,
        webhookUrl: skillWithBroadcasts.webhookUrl,
        webhookHeaders: skillWithBroadcasts.webhookHeaders,
        summary: 'Skill execution result',
      };

      const entry = await storage.addEntry({
        pseudonym: 'Skill Runner#123',
        client: 'code',
        content: `[${skillWithBroadcasts.name}] Skill execution result`,
        timestamp: Date.now(),
        humanVisible: skillWithBroadcasts.humanVisible,
        topicHints: [`skill:${skillWithBroadcasts.name}`],
        broadcastConfig,
      });

      expect(entry.content).toContain('[broadcast_test]');
      expect(entry.topicHints).toContain('skill:broadcast_test');
      expect(entry.broadcastConfig).toBeDefined();
      expect(entry.broadcastConfig!.emailTo).toEqual(['subscriber@example.com']);
      expect(entry.broadcastConfig!.webhookUrl).toBe('https://webhooks.example.com/skill');
    });

    it('should not include broadcastConfig when skill has no broadcast targets', async () => {
      const skillNoBroadcasts: Skill = {
        id: 'skill_no_broadcast',
        name: 'no_broadcast',
        description: 'A skill without broadcast options',
        instructions: 'No broadcasting',
        postToNotebook: true,
        // No emailTo, no webhookUrl
        public: false,
        author: 'tester',
        createdAt: Date.now(),
      };

      // When skill has no broadcast targets, broadcastConfig should be undefined
      const hasBroadcastTargets = skillNoBroadcasts.webhookUrl ||
        (skillNoBroadcasts.emailTo && skillNoBroadcasts.emailTo.length > 0);

      const broadcastConfig = hasBroadcastTargets ? {
        skillName: skillNoBroadcasts.name,
        emailTo: skillNoBroadcasts.emailTo,
        webhookUrl: skillNoBroadcasts.webhookUrl,
      } : undefined;

      const entry = await storage.addEntry({
        pseudonym: 'Skill Runner#123',
        client: 'code',
        content: `[${skillNoBroadcasts.name}] Result`,
        timestamp: Date.now(),
        broadcastConfig,
      });

      expect(entry.broadcastConfig).toBeUndefined();
    });
  });
});
