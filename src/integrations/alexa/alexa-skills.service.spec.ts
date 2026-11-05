import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { AlexaSkillsService } from './alexa-skills.service';

describe('AlexaSkillsService.upsert', () => {
  const upsert = jest.fn().mockResolvedValue({ id: 'sk1' });
  const findUnique = jest.fn();
  const service = new AlexaSkillsService(
    {
      user: { findUnique },
      alexaSkill: {
        upsert,
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'sk1', activationHash: null }),
      },
    } as unknown as PrismaService,
    { invalidate: jest.fn() } as unknown as AlexaSkillRepository,
  );
  const input = {
    applicationId: 'amzn1.ask.skill.x',
    label: 'Bella Chic',
    tenantId: 't1',
    actingUserId: 'u1',
  };

  beforeEach(() => upsert.mockClear());

  it('una skill de negocio no acepta a un super-admin como usuario', async () => {
    findUnique.mockResolvedValue({
      isActive: true,
      tenantId: 'lynko',
      isPlatformAdmin: true,
    });
    await expect(service.upsert(input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('acepta a un usuario de ese negocio', async () => {
    findUnique.mockResolvedValue({
      isActive: true,
      tenantId: 't1',
      isPlatformAdmin: false,
    });
    await service.upsert(input);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
