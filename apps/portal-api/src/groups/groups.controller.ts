import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { GroupsService } from './groups.service.js';

class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(120)
  title!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsEnum(['private', 'org', 'public'])
  access?: 'private' | 'org' | 'public';
}

class AddMemberDto {
  @IsString() userId!: string;
  @IsOptional() @IsEnum(['member', 'admin']) role?: 'member' | 'admin';
}

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.groups.listVisible(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGroupDto) {
    return this.groups.create(user, dto);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') groupId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.groups.addMember(user, groupId, dto.userId, dto.role ?? 'member');
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') groupId: string,
    @Param('userId') memberId: string,
  ) {
    return this.groups.removeMember(user, groupId, memberId);
  }
}
