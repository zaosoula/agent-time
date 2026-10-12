import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { Collector } from './src/capture/collector.ts';
import { dispatchRequest } from './src/capture/protocol.ts';
export default defineConfig({ plugins:[vue(),{
 name:'local-capture-preview',configureServer(server){
  const collector=new Collector(resolve(process.env.ADE_CAPTURE_OUTPUT||'.capture/preview'),resolve('.capture/bin/activity-probe'));
  server.middlewares.use('/__capture',async(req,res)=>{
   if(req.method!=='POST'){res.statusCode=405;res.end();return;}
   const origin=req.headers.origin;
   if(origin && !['http://localhost:1420','http://127.0.0.1:1420'].includes(origin)){res.statusCode=403;res.end();return;}
   try{let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw new Error('Request too large');}
    const reply=await dispatchRequest(JSON.parse(body),collector);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));
   }catch{res.statusCode=400;res.end('{"error":"Invalid request"}');}
  });
  server.httpServer?.on('close',()=>{void collector.close();});
 }}],server:{port:1420,strictPort:true,host:'127.0.0.1'},clearScreen:false,envPrefix:['VITE_'],build:{target:'es2022'} });
