import axios from 'axios';
//import {WebsocketBuilder} from 'websocket-ts';

export default class DreoAPI {
  public async getURL() {
    return await axios.get('https://www.dreo-cloud.com/access/endpoint', {
      params: {
        'timestamp': Date.now(),
      },
      headers: {
        'country': 'US',
        'ua': 'dreo/2.0.7 (sdk_gphone64_x86_64;android 13;Scale/2.625)',
        'lang': 'en',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    });
  }
}