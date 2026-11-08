import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { SignaturesService } from './signatures.service';

@Module({ imports: [DocumentsModule], controllers: [CommunicationController], providers: [CommunicationService, SignaturesService] })
export class CommunicationModule {}
