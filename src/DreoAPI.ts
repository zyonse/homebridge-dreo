import axios from 'axios';
import MD5 from 'crypto-js/md5';
//import {WebsocketBuilder} from 'websocket-ts';

// Follows same request structure as the mobile app
export default class DreoAPI {
  public async authenticate(email, password) {
    return await axios.post('https://app-api-us.dreo-cloud.com/api/oauth/login', {
      'client_id': '7de37c362ee54dcf9c4561812309347a',
      'client_secret': '32dfa0764f25451d99f94e1693498791',
      'email': email,
      'encrypt': 'ciphertext',
      'grant_type': 'email-password',
      'himei': 'faede31549d649f58864093158787ec9',
      'password': MD5(password).toString(),
      'scope': 'all',
    }, {
      params: {
        'timestamp': Date.now(),
      },
      headers: {
        'country': 'US',
        'ua': 'dreo/2.0.7 (sdk_gphone64_x86_64;android 13;Scale/2.625)',
        'lang': 'en',
        'content-type': 'application/json; charset=UTF-8',
        'accept-encoding': 'gzip',
        'user-agent': 'okhttp/4.9.1',
      },
    });
  }
}