import 'dotenv/config';
import { runAiDiagnostics } from './ai';

runAiDiagnostics().then((report) => {
  console.log(report);
  process.exit(0);
});