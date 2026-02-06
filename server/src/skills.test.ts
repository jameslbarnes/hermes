import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, type Skill, type SkillParameter } from './storage.js';
import { hashSecretKey } from './identity.js';
import { SYSTEM_SKILLS, validateSkillName, buildSkillInputSchema, buildSkillDescription, generateSkillId } from './http.js';

describe('Skills System', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM SKILLS DEFINITIONS
  // ═══════════════════════════════════════════════════════════════

  describe('System Skills', () => {
    it('should have hermes_write_entry as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_write_entry');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
      expect(skill!.id).toBe('system_hermes_write_entry');
    });

    it('should have hermes_search as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_search');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
    });

    it('should have hermes_skills with expanded action enum', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
      expect(skill!.inputSchema?.properties?.action?.enum).toEqual(
        ['list', 'edit', 'reset', 'create', 'get', 'update', 'delete']
      );
    });

    it('should have hermes_skills_browse as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills_browse');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
      expect(skill!.inputSchema?.properties?.query).toBeDefined();
      expect(skill!.inputSchema?.properties?.limit).toBeDefined();
    });

    it('should have hermes_skills_clone as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills_clone');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
      expect(skill!.inputSchema?.required).toEqual(['skill_name', 'author']);
    });

    it('should have hermes_follow as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_follow');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
    });

    it('should have inputSchema on all builtin skills', () => {
      const builtins = SYSTEM_SKILLS.filter(s => s.handlerType === 'builtin');
      expect(builtins.length).toBeGreaterThan(0);
      for (const skill of builtins) {
        expect(skill.inputSchema).toBeDefined();
      }
    });

    it('should NOT have hermes_broadcast as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_broadcast');
      expect(skill).toBeUndefined();
    });

    it('should have create/update fields in hermes_skills schema', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills');
      const props = skill!.inputSchema?.properties;
      expect(props.name).toBeDefined();
      expect(props.skill_id).toBeDefined();
      expect(props.parameters).toBeDefined();
      expect(props.trigger_condition).toBeDefined();
      expect(props.to).toBeDefined();
      expect(props.ai_only).toBeDefined();
      expect(props.visibility).toBeDefined(); // legacy, kept for compat
      expect(props.is_public).toBeDefined();
    });

    it('should have ai_only param in hermes_write_entry schema', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_write_entry');
      const props = skill!.inputSchema?.properties;
      expect(props.ai_only).toBeDefined();
      expect(props.ai_only.type).toBe('boolean');
    });

    it('should have defaultAiOnly param in hermes_settings schema', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_settings');
      const props = skill!.inputSchema?.properties;
      expect(props.defaultAiOnly).toBeDefined();
      expect(props.defaultAiOnly.type).toBe('boolean');
    });

    it('should have join_rule param in hermes_channels schema', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_channels');
      const props = skill!.inputSchema?.properties;
      expect(props.join_rule).toBeDefined();
      expect(props.join_rule.enum).toEqual(['open', 'invite']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL NAME VALIDATION
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Name Validation', () => {
    it('should accept valid names', () => {
      expect(validateSkillName('weekly_digest')).toBeNull();
      expect(validateSkillName('notify')).toBeNull();
      expect(validateSkillName('a')).toBeNull();
      expect(validateSkillName('test123')).toBeNull();
      expect(validateSkillName('my_skill_v2')).toBeNull();
    });

    it('should reject names starting with hermes', () => {
      expect(validateSkillName('hermes_foo')).not.toBeNull();
      expect(validateSkillName('hermes')).not.toBeNull();
    });

    it('should reject invalid characters', () => {
      expect(validateSkillName('My-Skill')).not.toBeNull();
      expect(validateSkillName('skill name')).not.toBeNull();
      expect(validateSkillName('UPPERCASE')).not.toBeNull();
      expect(validateSkillName('has.dot')).not.toBeNull();
    });

    it('should reject empty names', () => {
      expect(validateSkillName('')).not.toBeNull();
    });

    it('should reject names longer than 30 chars', () => {
      expect(validateSkillName('a'.repeat(31))).not.toBeNull();
      expect(validateSkillName('a'.repeat(30))).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL ID GENERATION
  // ═══════════════════════════════════════════════════════════════

  describe('Skill ID Generation', () => {
    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSkillId()));
      expect(ids.size).toBe(100);
    });

    it('should start with skill_ prefix', () => {
      const id = generateSkillId();
      expect(id.startsWith('skill_')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL INPUT SCHEMA BUILDING
  // ═══════════════════════════════════════════════════════════════

  describe('buildSkillInputSchema', () => {
    it('should always include result parameter', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'test',
        instructions: '',
        createdAt: Date.now(),
      };

      const schema = buildSkillInputSchema(skill);
      expect(schema.properties.result).toBeDefined();
      expect(schema.properties.result.type).toBe('string');
    });

    it('should map parameters to schema properties', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'test',
        instructions: '',
        parameters: [
          { name: 'topic', type: 'string', description: 'The topic', required: true },
          { name: 'count', type: 'number', description: 'How many' },
          { name: 'verbose', type: 'boolean', description: 'Verbose output' },
          { name: 'tags', type: 'array', description: 'Tags to include' },
        ],
        createdAt: Date.now(),
      };

      const schema = buildSkillInputSchema(skill);
      expect(schema.properties.topic.type).toBe('string');
      expect(schema.properties.count.type).toBe('number');
      expect(schema.properties.verbose.type).toBe('boolean');
      expect(schema.properties.tags.type).toBe('array');
      expect(schema.properties.tags.items).toEqual({ type: 'string' });
      expect(schema.required).toEqual(['topic']);
    });

    it('should include enum values', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'test',
        instructions: '',
        parameters: [
          { name: 'format', type: 'string', description: 'Output format', enum: ['json', 'markdown', 'text'] },
        ],
        createdAt: Date.now(),
      };

      const schema = buildSkillInputSchema(skill);
      expect(schema.properties.format.enum).toEqual(['json', 'markdown', 'text']);
    });

    it('should handle skill with no parameters', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'test',
        instructions: '',
        createdAt: Date.now(),
      };

      const schema = buildSkillInputSchema(skill);
      expect(Object.keys(schema.properties)).toEqual(['result']);
      expect(schema.required).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL DESCRIPTION BUILDING
  // ═══════════════════════════════════════════════════════════════

  describe('buildSkillDescription', () => {
    it('should return base description for simple skill', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'A simple skill',
        instructions: '',
        createdAt: Date.now(),
      };

      expect(buildSkillDescription(skill)).toBe('A simple skill');
    });

    it('should include destinations', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'A skill',
        instructions: '',
        to: ['@alice', 'bob@example.com'],
        createdAt: Date.now(),
      };

      const desc = buildSkillDescription(skill);
      expect(desc).toContain('@alice');
      expect(desc).toContain('bob@example.com');
      expect(desc).toContain('Default destinations');
    });

    it('should include trigger condition', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'A skill',
        instructions: '',
        triggerCondition: 'when user mentions their week',
        createdAt: Date.now(),
      };

      const desc = buildSkillDescription(skill);
      expect(desc).toContain('Trigger: when user mentions their week');
    });

    it('should include instructions', () => {
      const skill: Skill = {
        id: 'test',
        name: 'test',
        description: 'A skill',
        instructions: 'Summarize in 3 bullet points',
        createdAt: Date.now(),
      };

      const desc = buildSkillDescription(skill);
      expect(desc).toContain('Instructions: Summarize in 3 bullet points');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL OVERRIDES (tool customization)
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Overrides', () => {
    const testUser = {
      handle: 'customizer',
      secretKeyHash: hashSecretKey('test-secret-key-for-overrides'),
    };

    it('should default skillOverrides to undefined', async () => {
      const user = await storage.createUser(testUser);
      expect(user.skillOverrides).toBeUndefined();
    });

    it('should store skill overrides on user', async () => {
      await storage.createUser(testUser);

      const overrides = {
        hermes_write_entry: {
          instructions: 'Keep entries under 100 characters',
        },
      };

      const updated = await storage.updateUser('customizer', {
        skillOverrides: overrides,
      });

      expect(updated!.skillOverrides).toBeDefined();
      expect(updated!.skillOverrides!.hermes_write_entry).toBeDefined();
      expect(updated!.skillOverrides!.hermes_write_entry.instructions).toBe('Keep entries under 100 characters');
    });

    it('should store description override', async () => {
      await storage.createUser(testUser);

      const overrides = {
        hermes_search: {
          description: 'Custom search description',
        },
      };

      const updated = await storage.updateUser('customizer', {
        skillOverrides: overrides,
      });

      expect(updated!.skillOverrides!.hermes_search!.description).toBe('Custom search description');
    });

    it('should store multiple overrides', async () => {
      await storage.createUser(testUser);

      const overrides = {
        hermes_write_entry: { instructions: 'Be brief' },
        hermes_search: { instructions: 'Search broadly' },
      };

      const updated = await storage.updateUser('customizer', {
        skillOverrides: overrides,
      });

      expect(Object.keys(updated!.skillOverrides!)).toHaveLength(2);
    });

    it('should reset overrides by setting empty object', async () => {
      await storage.createUser(testUser);

      await storage.updateUser('customizer', {
        skillOverrides: { hermes_write_entry: { instructions: 'Be brief' } },
      });

      const updated = await storage.updateUser('customizer', {
        skillOverrides: {},
      });

      expect(Object.keys(updated!.skillOverrides!)).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // USER SKILLS STORAGE
  // ═══════════════════════════════════════════════════════════════

  describe('User Skills Storage', () => {
    const testUser = {
      handle: 'skillmaker',
      secretKeyHash: hashSecretKey('test-secret-key-for-skills'),
    };

    it('should default skills to undefined', async () => {
      const user = await storage.createUser(testUser);
      expect(user.skills).toBeUndefined();
    });

    it('should store skills on user', async () => {
      await storage.createUser(testUser);

      const skills: Skill[] = [{
        id: 'skill_abc123',
        name: 'weekly_digest',
        description: 'Generate a weekly digest',
        instructions: 'Summarize the week',
        handlerType: 'instructions',
        author: 'skillmaker',
        createdAt: Date.now(),
      }];

      const updated = await storage.updateUser('skillmaker', { skills });
      expect(updated!.skills).toHaveLength(1);
      expect(updated!.skills![0].name).toBe('weekly_digest');
    });

    it('should store skills with all fields', async () => {
      await storage.createUser(testUser);

      const skills: Skill[] = [{
        id: 'skill_full',
        name: 'notify_team',
        description: 'Send a team update',
        instructions: 'Format as bullet points',
        handlerType: 'instructions',
        parameters: [
          { name: 'topic', type: 'string', description: 'Update topic', required: true },
        ],
        triggerCondition: 'when user mentions team standup',
        to: ['@alice', '@bob'],
        visibility: 'private',
        public: true,
        author: 'skillmaker',
        cloneCount: 5,
        createdAt: Date.now(),
      }];

      const updated = await storage.updateUser('skillmaker', { skills });
      const skill = updated!.skills![0];
      expect(skill.parameters).toHaveLength(1);
      expect(skill.triggerCondition).toBe('when user mentions team standup');
      expect(skill.to).toEqual(['@alice', '@bob']);
      expect(skill.visibility).toBe('private');
      expect(skill.public).toBe(true);
      expect(skill.cloneCount).toBe(5);
    });

    it('should store multiple skills', async () => {
      await storage.createUser(testUser);

      const skills: Skill[] = [
        {
          id: 'skill_1',
          name: 'skill_one',
          description: 'First skill',
          instructions: '',
          createdAt: Date.now(),
        },
        {
          id: 'skill_2',
          name: 'skill_two',
          description: 'Second skill',
          instructions: '',
          createdAt: Date.now(),
        },
      ];

      const updated = await storage.updateUser('skillmaker', { skills });
      expect(updated!.skills).toHaveLength(2);
    });

    it('should replace skills array on update', async () => {
      await storage.createUser(testUser);

      await storage.updateUser('skillmaker', {
        skills: [{
          id: 'skill_old',
          name: 'old_skill',
          description: 'Old skill',
          instructions: '',
          createdAt: Date.now(),
        }],
      });

      const updated = await storage.updateUser('skillmaker', {
        skills: [{
          id: 'skill_new',
          name: 'new_skill',
          description: 'New skill',
          instructions: '',
          createdAt: Date.now(),
        }],
      });

      expect(updated!.skills).toHaveLength(1);
      expect(updated!.skills![0].name).toBe('new_skill');
    });

    it('should clear skills with empty array', async () => {
      await storage.createUser(testUser);

      await storage.updateUser('skillmaker', {
        skills: [{
          id: 'skill_x',
          name: 'some_skill',
          description: 'A skill',
          instructions: '',
          createdAt: Date.now(),
        }],
      });

      const updated = await storage.updateUser('skillmaker', { skills: [] });
      expect(updated!.skills).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GALLERY & CLONING
  // ═══════════════════════════════════════════════════════════════

  describe('Gallery & Cloning', () => {
    it('should find public skills across users', async () => {
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key'),
      });
      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-key'),
      });

      await storage.updateUser('alice', {
        skills: [{
          id: 'skill_a1',
          name: 'public_skill',
          description: 'A public skill',
          instructions: 'Do something',
          public: true,
          author: 'alice',
          cloneCount: 3,
          createdAt: Date.now(),
        }],
      });

      await storage.updateUser('bob', {
        skills: [{
          id: 'skill_b1',
          name: 'private_skill',
          description: 'A private skill',
          instructions: 'Do something else',
          public: false,
          author: 'bob',
          createdAt: Date.now(),
        }],
      });

      const allUsers = await storage.getAllUsers();
      const publicSkills = allUsers.flatMap(u =>
        (u.skills || []).filter(s => s.public)
      );

      expect(publicSkills).toHaveLength(1);
      expect(publicSkills[0].name).toBe('public_skill');
    });

    it('should track clonedFrom metadata', async () => {
      await storage.createUser({
        handle: 'cloner',
        secretKeyHash: hashSecretKey('cloner-key'),
      });

      const clonedSkill: Skill = {
        id: 'skill_cloned',
        name: 'cloned_skill',
        description: 'Cloned from alice',
        instructions: 'Do something',
        handlerType: 'instructions',
        public: false,
        author: 'cloner',
        clonedFrom: 'alice/skill_a1',
        cloneCount: 0,
        createdAt: Date.now(),
      };

      await storage.updateUser('cloner', { skills: [clonedSkill] });
      const user = await storage.getUser('cloner');
      expect(user!.skills![0].clonedFrom).toBe('alice/skill_a1');
      expect(user!.skills![0].public).toBe(false);
      expect(user!.skills![0].to).toBeUndefined();
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
  // AIONLY FIELD (unified privacy model)
  // ═══════════════════════════════════════════════════════════════

  describe('aiOnly Field', () => {
    it('should store aiOnly on entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'AI-only entry via new field',
        timestamp: Date.now(),
        aiOnly: true,
      });

      expect(entry.aiOnly).toBe(true);
    });

    it('should store both aiOnly and humanVisible for backward compat', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        client: 'code',
        content: 'Dual-field entry',
        timestamp: Date.now(),
        aiOnly: true,
        humanVisible: false,
      });

      expect(entry.aiOnly).toBe(true);
      expect(entry.humanVisible).toBe(false);
    });

    it('should store defaultAiOnly on user', async () => {
      await storage.createUser({
        handle: 'newuser',
        secretKeyHash: hashSecretKey('newuser-key'),
      });

      const updated = await storage.updateUser('newuser', {
        defaultAiOnly: true,
      });

      expect(updated!.defaultAiOnly).toBe(true);
    });

    it('should store aiOnly on skills', async () => {
      await storage.createUser({
        handle: 'skilluser',
        secretKeyHash: hashSecretKey('skilluser-key'),
      });

      const skills: Skill[] = [{
        id: 'skill_ai',
        name: 'ai_skill',
        description: 'An AI-only skill',
        instructions: '',
        aiOnly: true,
        author: 'skilluser',
        createdAt: Date.now(),
      }];

      const updated = await storage.updateUser('skilluser', { skills });
      expect(updated!.skills![0].aiOnly).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL ENTRIES (topicHints with skill: prefix)
  // ═══════════════════════════════════════════════════════════════

  describe('Skill Entries', () => {
    it('should store entries with skill topic hints', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'skillmaker',
        client: 'code',
        content: 'Weekly update posted via skill',
        timestamp: Date.now(),
        model: 'skill',
        topicHints: ['skill:weekly_digest'],
        to: ['@alice'],
      });

      expect(entry.model).toBe('skill');
      expect(entry.topicHints).toContain('skill:weekly_digest');
      expect(entry.to).toEqual(['@alice']);
    });
  });
});
