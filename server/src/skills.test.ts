import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, type Skill } from './storage.js';
import { hashSecretKey } from './identity.js';
import { SYSTEM_SKILLS } from './http.js';

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

    it('should have hermes_skills as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills');
      expect(skill).toBeDefined();
      expect(skill!.handlerType).toBe('builtin');
      expect(skill!.inputSchema?.properties?.action?.enum).toEqual(['list', 'edit', 'reset']);
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

    it('should NOT have hermes_skills_browse as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills_browse');
      expect(skill).toBeUndefined();
    });

    it('should NOT have hermes_skills_clone as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_skills_clone');
      expect(skill).toBeUndefined();
    });

    it('should NOT have hermes_write_essay as a system skill', () => {
      const skill = SYSTEM_SKILLS.find(s => s.name === 'hermes_write_essay');
      expect(skill).toBeUndefined();
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
});
