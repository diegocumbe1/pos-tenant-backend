/**
 * Genera el valor de ALEXA_ACTIVATION_SECRET_HASH a partir de una frase hablada.
 * La frase se pide con el eco apagado y nunca se imprime ni se guarda en disco.
 *
 *   npm run alexa:hash
 */
import { createInterface, Interface } from 'node:readline';
import {
  hashActivationPhrase,
  verifyActivationPhrase,
} from '../src/integrations/alexa/activation-secret';

type MutableInterface = Interface & {
  output: NodeJS.WritableStream;
  _writeToOutput: (chunk: string) => void;
};

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    }) as MutableInterface;
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log(
    'Frase de activación de Lynko para Alexa.\n' +
      'Usa al menos tres palabras que Alexa pueda transcribir bien en español.\n' +
      'No se muestra en pantalla y no queda en el historial de la terminal.\n',
  );

  const phrase = await askHidden('Frase: ');
  const confirmation = await askHidden('Repite la frase: ');

  const hash = await hashActivationPhrase(phrase);
  if (!(await verifyActivationPhrase(confirmation, hash))) {
    throw new Error(
      'Las dos frases no coinciden. Vuelve a ejecutar el script.',
    );
  }

  console.log(
    '\nCopia esta línea en .env.local y en las variables de Railway:\n',
  );
  console.log(`ALEXA_ACTIVATION_SECRET_HASH="${hash}"\n`);
  console.log(
    'Guarda la frase solo en tu gestor de contraseñas. El hash no permite recuperarla:\n' +
      'si la olvidas, genera una nueva y reemplaza la variable.',
  );
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
